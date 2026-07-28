# Solicitud de documentacion

## Que necesito

Documenta de forma resumida la implementación end-to-end de Documentador en el repositorio Atlas.

## Instrucciones de formato

- Responde **solo** con el documento final en Markdown, listo para pegar.
- Sin preambulo, sin explicar lo que vas a hacer y sin envolverlo en un bloque de codigo.
- Usa encabezados `##`, y enlaza los archivos por su ruta relativa tal cual aparece abajo.
- Si algo no se deduce del codigo incluido, dilo explicitamente en vez de inventarlo.

## Contexto

- Repositorio: `C:\Users\tiand\Desktop\Workspace\atlas`
- Archivos incluidos: 3

Por que estos archivos: Selección del agente local de Karajan para Documentador.

## Archivos

### `apps/server/src/core/auth/auth.service.ts`

```typescript
import { Injectable, UnauthorizedException, ConflictException, NotFoundException, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import type { Knex } from 'knex';

import { KNEX_TOKEN } from '../../database/database.module';
import { UsersService } from '../users/users.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any;

const LOCAL_USER_EMAIL = 'local@atlas.local';
const SPECIAL_WORKSPACES = [
  { key: 'bug_solver', title: 'Bug Solver', icon: '🐞' },
  { key: 'commander', title: 'Commander', icon: '⌘' },
  { key: 'documentador', title: 'Documentador', icon: '📚' },
] as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    @Inject(KNEX_TOKEN) private readonly db: Knex,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user: AnyRow = await this.usersService.create({
      name: dto.name,
      email: dto.email,
      passwordHash,
    });

    // Todo usuario nuevo necesita un workspace propio; sin él, pages/databases fallan.
    const workspaceId = await this.createDefaultWorkspace(user.id as string, dto.workspaceName ?? `Espacio de ${dto.name}`);
    await this.ensureSpecialWorkspaces(user.id as string, workspaceId);

    return { tokens: this.signTokens(user.id as string), user: this.safeUser(user) };
  }

  async login(dto: LoginDto) {
    const user: AnyRow = await this.usersService.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.password_hash as string);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    await this.ensureSpecialWorkspaces(user.id as string);

    return { tokens: this.signTokens(user.id as string), user: this.safeUser(user) };
  }

  async localSession() {
    if ((process.env['DATABASE_DRIVER'] ?? 'sqlite') === 'pg') {
      throw new NotFoundException('Local session not available in server mode');
    }

    let user: AnyRow = await this.usersService.findByEmail(LOCAL_USER_EMAIL);

    if (!user) {
      user = await this.usersService.create({
        name: 'Local',
        email: LOCAL_USER_EMAIL,
        passwordHash: await bcrypt.hash(uuid(), 4),
      });

      await this.createDefaultWorkspace(user.id as string, 'Mi espacio');
    }

    await this.ensureSpecialWorkspaces(user.id as string);

    return {
      token: this.jwtService.sign({ sub: user.id as string }),
      user: this.safeUser(user),
    };
  }

  /** Crea un workspace propio + membresía owner para un usuario recién creado. */
  private async createDefaultWorkspace(userId: string, name: string): Promise<string> {
    const workspaceId = uuid();
    await this.db('workspaces').insert({
      id: workspaceId,
      name,
      slug: `ws-${workspaceId.slice(0, 8)}`,
      owner_id: userId,
    });
    await this.db('workspace_members').insert({
      workspace_id: workspaceId,
      user_id: userId,
      role: 'owner',
    });
    return workspaceId;
  }

  /** Siembra los workspaces de producto una sola vez para usuarios nuevos y existentes. */
  private async ensureSpecialWorkspaces(userId: string, preferredWorkspaceId?: string) {
    const workspaceId = preferredWorkspaceId ?? await this.db('workspace_members')
      .join('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
      .where({ 'workspace_members.user_id': userId })
      .orderBy('workspaces.created_at', 'asc')
      .first('workspaces.id')
      .then((row) => row?.id as string | undefined);
    if (!workspaceId) return;

    const existing = await this.db('pages')
      .where({ workspace_id: workspaceId, addon_id: 'atlas-dev' })
      .select('id', 'title', 'content', 'properties', 'deleted_at');
    const byKey = new Map<string, AnyRow>();
    for (const page of existing) {
      const raw = typeof page.properties === 'string' ? JSON.parse(page.properties || '{}') : (page.properties ?? {});
      const key = raw?.workspace_key?.value ?? raw?.workspace_key;
      if (typeof key === 'string') byKey.set(key, page);
    }

    for (const special of SPECIAL_WORKSPACES) {
      const properties = {
        workspace_key: { type: 'text', value: special.key },
        protected: { type: 'boolean', value: true },
      };
      const page = byKey.get(special.key);
      if (page) {
        await this.db('pages').where({ id: page.id }).update({
          properties: JSON.stringify(properties),
          ...(page.deleted_at ? { deleted_at: null } : {}),
          updated_at: new Date(),
        });
        if (special.key === 'documentador') {
          await this.ensureDocumentatorDatabase(userId, workspaceId, page.id as string);
        }
        continue;
      }
      const pageId = uuid();
      await this.db('pages').insert({
        id: pageId,
        workspace_id: workspaceId,
        creator_id: userId,
        parent_page_id: null,
        title: special.title,
        icon: special.icon,
        content: null,
        addon_id: 'atlas-dev',
        properties: JSON.stringify(properties),
        position: SPECIAL_WORKSPACES.indexOf(special),
      });
      if (special.key === 'documentador') {
        await this.ensureDocumentatorDatabase(userId, workspaceId, pageId);
      }
    }

    // Demo se sembró en una versión anterior. Solo se toca la página que lleva
    // la marca interna exacta y cuyo contenido sigue vacío.
    const demo = byKey.get('demo');
    if (demo && !demo.deleted_at && isEmptyDocument(demo.content)) {
      await this.db('pages').where({ id: demo.id }).update({ deleted_at: new Date(), updated_at: new Date() });
    }
  }

  /** Crea/repara la única base Documentador y la incrusta en su workspace. */
  private async ensureDocumentatorDatabase(userId: string, workspaceId: string, pageId: string) {
    let database = await this.db('databases')
      .where({ workspace_id: workspaceId, workflow_key: 'documentador' })
      .orderBy('created_at', 'asc')
      .first();

    if (!database) {
      const databaseId = uuid();
      await this.db('databases').insert({
        id: databaseId,
        workspace_id: workspaceId,
        title: 'Documentador',
        icon: '📚',
        workflow_key: 'documentador',
      });
      await this.seedDocumentatorSchema(databaseId);
      database = { id: databaseId };
    }

    const hasView = await this.db('db_views')
      .where({ database_id: database.id, type: 'thread' })
      .first();
    if (!hasView) await this.seedDocumentatorSchema(database.id as string, true);

    await this.db('pages').where({ id: pageId }).update({
      content: JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Describe qué quieres documentar. El repositorio se detectará o podrás seleccionarlo antes de enviar.' }],
          },
          { type: 'databaseBlock', attrs: { databaseId: database.id, view: 'thread', synced: false } },
          { type: 'paragraph' },
        ],
      }),
      updated_at: new Date(),
    });
  }

  private async seedDocumentatorSchema(databaseId: string, viewOnly = false) {
    let fields = await this.db('db_fields').where({ database_id: databaseId }).orderBy('position', 'asc');
    if (!viewOnly && fields.length === 0) {
      const groups = [
        { id: uuid(), label: 'To-do', color: 'gray' },
        { id: uuid(), label: 'In progress', color: 'blue' },
        { id: uuid(), label: 'Complete', color: 'green' },
      ];
      const choices = [
        ['Borrador', 'gray', groups[0]!.id],
        ['Seleccionando contexto', 'blue', groups[1]!.id],
        ['Esperando ChatGPT', 'yellow', groups[1]!.id],
        ['Listo para revisión', 'purple', groups[1]!.id],
        ['Publicado', 'green', groups[2]!.id],
        ['Rechazado', 'gray', groups[2]!.id],
        ['Error', 'red', groups[2]!.id],
      ].map(([label, color, groupId]) => ({ id: uuid(), label, color, groupId }));
      const specs = [
        ['Comanda', 'text', null],
        ['Estado', 'status', { groups, choices }],
        ['Repository', 'select', { choices: [] }],
        ['Modo', 'multiSelect', { choices: [{ id: uuid(), label: 'documentar', color: 'blue' }] }],
        ['Tarea', 'text', null],
        ['Enviado', 'date', null],
        ['Eslabón padre', 'text', null],
      ] as const;
      await this.db('db_fields').insert(specs.map(([name, type, options], position) => ({
        id: uuid(),
        database_id: databaseId,
        name,
        type,
        position,
        options: options ? JSON.stringify(options) : null,
      })));
      fields = await this.db('db_fields').where({ database_id: databaseId }).orderBy('position', 'asc');
    }
    const field = (name: string) => fields.find((item) => item.name === name)?.id;
    await this.db('db_views').insert({
      id: uuid(),
      database_id: databaseId,
      name: 'Hilo',
      type: 'thread',
      position: 0,
      visibility: 'shared',
      owner_user_id: null,
      config: JSON.stringify({
        options: {
          colorPreset: 'none',
          showDataSourceTitle: true,
          showPageIcon: true,
          openPagesIn: 'side',
          loadLimit: 50,
          commanderStateFieldId: field('Estado'),
          commanderRepoFieldId: field('Repository'),
          commanderModeFieldId: field('Modo'),
          commanderTaskFieldId: field('Tarea'),
          commanderSentFieldId: field('Enviado'),
          commanderParentFieldId: field('Eslabón padre'),
          commanderLayout: 'default',
        },
      }),
    });
  }

  /** Revalida el catálogo especial cuando una sesión ya tenía token persistido. */
  async ensureSpecialWorkspacesFor(userId: string) {
    await this.ensureSpecialWorkspaces(userId);
  }

  private signTokens(userId: string) {
    return {
      accessToken: this.jwtService.sign({ sub: userId }),
      refreshToken: this.jwtService.sign({ sub: userId }, { expiresIn: '30d' }),
    };
  }

  private safeUser(user: AnyRow) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password_hash, ...safe } = user as Record<string, unknown>;
    return safe;
  }
}

function isEmptyDocument(raw: unknown): boolean {
  if (raw == null || raw === '') return true;
  try {
    const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const content = (doc as { content?: unknown[] } | null)?.content;
    if (!Array.isArray(content) || content.length === 0) return true;
    return content.every((node) => {
      const item = node as { type?: string; content?: unknown[] };
      return item.type === 'paragraph' && (!Array.isArray(item.content) || item.content.length === 0);
    });
  } catch {
    return false;
  }
}
```

### `apps/server/src/core/documentator/documentator.service.ts`

```typescript
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Knex } from 'knex';

import { KNEX_TOKEN } from '../../database/database.module';
import { AddonInvokerService } from '../addons/addon-invoker.service';
import { AtlasDevService } from '../atlas-dev/atlas-dev.service';
import { DocImportService } from '../atlas-dev/doc-import.service';
import { getDevEntry } from '../atlas-dev/dev-store';

type StartDto = {
  taskId: string;
  prompt: string;
  repository: string;
  contextPaths?: string[];
  rationale?: string;
};

type PackDetail = {
  id: string;
  markdown: string;
  status: string;
  result_markdown?: string | null;
};

@Injectable()
export class DocumentatorService {
  constructor(
    @Inject(KNEX_TOKEN) private readonly db: Knex,
    private readonly invoker: AddonInvokerService,
    private readonly atlasDev: AtlasDevService,
    private readonly importer: DocImportService,
  ) {}

  async get(userId: string, pageId: string) {
    await this.assertDocumentatorPage(userId, pageId);
    const row = await this.db('documentator_jobs').where({ page_id: pageId }).first();
    if (!row) return null;
    let pack: PackDetail | null = null;
    if (row.pack_id) {
      const response = await this.invoker.invoke<PackDetail>('karajan', 'handoffGet', { packId: row.pack_id });
      if (response.ok) pack = response.data;
    }
    return { ...hydrateJob(row), pack };
  }

  async start(userId: string, pageId: string, dto: StartDto) {
    const { database } = await this.assertDocumentatorPage(userId, pageId);
    const target = this.repository(dto.repository);
    let paths = [...new Set((dto.contextPaths ?? []).map((item) => item.trim()).filter(Boolean))];
    if (!paths.length) {
      const delegated = await this.invoker.invoke<any>('karajan', 'delegate', {
        task_id: dto.taskId,
        workspace_root: target.repoPath,
        agent_tools: 'doc',
      });
      if (!delegated.ok) throw new BadRequestException(`Karajan respondió ${delegated.status}`);
      const executions = delegated.data?.delegation?.executions ?? [];
      paths = [...new Set<string>(
        (executions as Array<{ context_paths?: unknown[] }>).flatMap((item) =>
          Array.isArray(item.context_paths) ? item.context_paths.map(String) : [],
        ),
      )];
    }
    if (!paths.length) throw new BadRequestException('Karajan no seleccionó ningún fichero de contexto.');

    await this.upsert(pageId, userId, {
      task_id: dto.taskId,
      repository: target.id,
      workspace_root: target.repoPath,
      context_paths: JSON.stringify(paths),
      status: 'selecting_context',
      error: null,
    });
    await this.projectStatus(database.id, pageId, 'Seleccionando contexto');

    try {
      const response = await this.invoker.invoke<PackDetail>('karajan', 'handoffCreate', {
        task_id: dto.taskId,
        prompt: dto.prompt,
        paths,
        workspace_root: target.repoPath,
        rationale: dto.rationale ?? 'Selección del agente local de Karajan para Documentador.',
      });
      if (!response.ok) throw new Error(`Karajan respondió ${response.status}`);
      await this.upsert(pageId, userId, {
        pack_id: response.data.id,
        status: 'waiting_chatgpt',
        error: null,
      });
      await this.projectStatus(database.id, pageId, 'Esperando ChatGPT');
      return this.get(userId, pageId);
    } catch (error) {
      await this.fail(database.id, pageId, error);
      throw error;
    }
  }

  async submitResult(userId: string, pageId: string, markdown: string) {
    const { database } = await this.assertDocumentatorPage(userId, pageId);
    const job = await this.requireJob(pageId);
    if (!job.pack_id) throw new BadRequestException('La tarjeta todavía no tiene paquete de contexto.');
    try {
      const response = await this.invoker.invoke<PackDetail>('karajan', 'handoffResult', {
        packId: job.pack_id,
        markdown,
      });
      if (!response.ok) throw new Error(`Karajan respondió ${response.status}`);
      await this.upsert(pageId, userId, {
        status: 'ready_for_review',
        result_markdown: markdown,
        result_hash: createHash('sha256').update(markdown).digest('hex'),
        error: null,
      });
      await this.projectStatus(database.id, pageId, 'Listo para revisión');
      return this.get(userId, pageId);
    } catch (error) {
      await this.fail(database.id, pageId, error);
      throw error;
    }
  }

  async reject(userId: string, pageId: string) {
    const { database } = await this.assertDocumentatorPage(userId, pageId);
    await this.requireJob(pageId);
    await this.upsert(pageId, userId, { status: 'rejected', error: null });
    await this.projectStatus(database.id, pageId, 'Rechazado');
    return this.get(userId, pageId);
  }

  async publish(userId: string, pageId: string, dto: { slug: string; title: string }) {
    const { database } = await this.assertDocumentatorPage(userId, pageId);
    const job = await this.requireJob(pageId);
    if (!job.result_markdown) throw new BadRequestException('No hay resultado que aceptar.');
    const target = this.repository(job.repository);

    try {
      const source = this.sourcePath(target.id, target.repoPath, dto.slug);
      if (target.id !== 'atlas') atomicWrite(source, job.result_markdown);

      this.atlasDev.saveDoc({
        app: target.id,
        slug: dto.slug,
        title: dto.title,
        responsibility: 'documentacion',
        kind: 'logica',
        tags: ['documentador', 'karajan'],
        status: 'published',
        body: job.result_markdown,
      });
      const imported = await this.importer.importApp(userId, target.id);
      await this.upsert(pageId, userId, {
        status: 'published',
        source_path: relative(target.repoPath, source),
        atlas_app: target.id,
        atlas_slug: dto.slug,
        accepted_at: new Date(),
        published_at: new Date(),
        error: null,
      });
      await this.projectStatus(database.id, pageId, 'Publicado');
      return { ...(await this.get(userId, pageId)), imported };
    } catch (error) {
      await this.fail(database.id, pageId, error);
      throw error;
    }
  }

  private async assertDocumentatorPage(userId: string, pageId: string) {
    const row = await this.db('db_rows').where({ page_id: pageId }).first();
    if (!row) throw new NotFoundException('Tarjeta de Documentador no encontrada.');
    const database = await this.db('databases').where({ id: row.database_id, workflow_key: 'documentador' }).first();
    if (!database) throw new NotFoundException('Tarjeta de Documentador no encontrada.');
    const member = await this.db('workspace_members')
      .where({ workspace_id: database.workspace_id, user_id: userId })
      .first();
    if (!member) throw new NotFoundException('Tarjeta de Documentador no encontrada.');
    return { row, database };
  }

  private repository(id: string) {
    if (!['atlas', 'karajan', 'naityer_setup'].includes(id)) {
      throw new BadRequestException(`Repositorio no publicable: ${id}`);
    }
    const entry = getDevEntry(id);
    if (!entry) throw new BadRequestException(`Repositorio no configurado: ${id}`);
    return { id, repoPath: resolve(entry.repoPath) };
  }

  private sourcePath(repository: string, root: string, slug: string) {
    const path = repository === 'atlas'
      ? join(root, 'docs', 'apps', 'atlas', `${slug}.md`)
      : join(root, 'docs', `${slug}.md`);
    const resolved = resolve(path);
    const inside = relative(resolve(root), resolved);
    if (inside.startsWith('..') || resolve(inside) === inside) {
      throw new BadRequestException('Ruta de publicación fuera del repositorio.');
    }
    return resolved;
  }

  private async requireJob(pageId: string) {
    const job = await this.db('documentator_jobs').where({ page_id: pageId }).first();
    if (!job) throw new NotFoundException('Trabajo documental no encontrado.');
    return job;
  }

  private async upsert(pageId: string, userId: string, patch: Record<string, unknown>) {
    const existing = await this.db('documentator_jobs').where({ page_id: pageId }).first();
    if (existing) {
      await this.db('documentator_jobs').where({ page_id: pageId }).update({ ...patch, updated_at: new Date() });
      return;
    }
    await this.db('documentator_jobs').insert({
      id: randomUUID(),
      page_id: pageId,
      repository: '',
      workspace_root: '',
      status: 'draft',
      created_by: userId,
      ...patch,
    });
  }

  private async fail(databaseId: string, pageId: string, error: unknown) {
    await this.db('documentator_jobs').where({ page_id: pageId }).update({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      updated_at: new Date(),
    });
    await this.projectStatus(databaseId, pageId, 'Error');
  }

  private async projectStatus(databaseId: string, pageId: string, label: string) {
    const row = await this.db('db_rows').where({ database_id: databaseId, page_id: pageId }).first();
    const field = await this.db('db_fields').where({ database_id: databaseId, name: 'Estado' }).first();
    if (!row || !field) return;
    const options = parse(field.options);
    const choice = (options.choices as Array<{ id: string; label: string }> | undefined)
      ?.find((item) => item.label === label);
    if (!choice) return;
    const data = parse(row.data);
    data[field.id] = choice.id;
    await this.db('db_rows').where({ id: row.id }).update({ data: JSON.stringify(data), updated_at: new Date() });
  }
}

function parse(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, any>;
  try { return JSON.parse(String(value)) as Record<string, any>; } catch { return {}; }
}

function hydrateJob(row: Record<string, any>) {
  let contextPaths: string[] = [];
  try {
    const parsed = typeof row.context_paths === 'string' ? JSON.parse(row.context_paths) : row.context_paths;
    if (Array.isArray(parsed)) contextPaths = parsed.map(String);
  } catch {
    contextPaths = [];
  }
  return {
    id: row.id,
    pageId: row.page_id,
    taskId: row.task_id,
    packId: row.pack_id,
    repository: row.repository,
    contextPaths,
    status: row.status,
    resultMarkdown: row.result_markdown,
    resultHash: row.result_hash,
    sourcePath: row.source_path,
    atlasApp: row.atlas_app,
    atlasSlug: row.atlas_slug,
    error: row.error,
    acceptedAt: row.accepted_at,
    publishedAt: row.published_at,
  };
}

function atomicWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, 'utf8');
  renameSync(temp, path);
}
```

### `apps/web/src/features/databases/components/thread-view.tsx`

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ChevronRight, CornerDownRight, ExternalLink, GitBranch, Link2, Loader2, PanelRightOpen, PanelTop,
  Plus, RotateCcw, Trash2, Workflow, Wrench,
} from 'lucide-react';
import { Badge, cn } from '@atlas/ui';
import type { PageProperties } from '@atlas/types';

import { PageProtocolPanel } from '@/features/pages/components/page-protocol-panel';
import { SendToKarajan } from '@/features/addons/components/send-to-karajan';
import { detectRepositoryFromPrompt, isDocumentadorProperties } from '@/features/addons/lib/documentador-policy';
import { DocumentatorHandoff } from '@/features/addons/documentator/documentator-handoff';
import { useDocumentatorMutations } from '@/features/addons/documentator/use-documentator';
import { usePage, useUpdatePage } from '@/features/pages/hooks/use-pages';
import { pageService } from '@/features/pages/services/page.service';
import { useHeaderProtocol } from '@/features/pages/hooks/use-header-protocol';
import { usePageFlow, type FlowEntry } from '@/features/addons/hooks/use-page-flow';
import { useInstalledAddons } from '@/features/addons/hooks/use-installed-addons';
import { isReviewBlocked, useApproveReviewInKarajan, useDelegateInKarajan } from '@/features/addons/karajan/use-karajan';
import type { KarajanDelegation, KarajanTask } from '@/features/addons/karajan/karajan.types';
import type { useDatabaseMutations } from '../hooks/use-databases';
import type { DatabaseFull, DatabaseView, DbField, DbRow } from '../services/database.service';
import { buildCommanderTree, type CommanderLayout } from '../lib/commander-layout';
import { cellText } from './database-view-utils';

/**
 * **Commander** — el hilo de ejecuciones.
 *
 * Cada fila es un *eslabón*: un prompt, la cabecera que dice con qué ejecutarlo y
 * el rastro de lo que Karajan hizo con él. Se escribe expandido, se envía, y al
 * enviarse se compacta a una línea que forma parte de la cadena.
 *
 * ## Dónde vive el dato
 *
 * En la **página** de la fila (`db_rows.page_id`), no en la fila: su Header
 * Protocol son `pages.properties` —los mismos que edita `PageProtocolPanel` en
 * cualquier nota, con los mismos catálogos vivos— y su cuerpo es `pages.content`.
 * Las columnas de la base son una *proyección* que escribe solo esta vista, y que
 * existe para que la vista Table sirva de algo. Ver
 * `docs/apps/atlas/logica-commander.md`.
 *
 * ## Por qué el eslabón compactado no consulta nada
 *
 * Lee de `row.data` y ya. Un hilo de cincuenta comandas con una consulta de
 * página y otra de flujo por eslabón —esta última refrescándose cada 30 s— es un
 * martilleo constante contra el servidor y contra Karajan para pintar una línea
 * de texto. La proyección es justo lo que evita eso: el estado se escribe al
 * enviar y se refresca al desplegar.
 */
export function ThreadView({
  data,
  view,
  mutations,
  onOpenRow,
  onLayoutChange,
}: {
  data: DatabaseFull;
  view: DatabaseView;
  mutations: ReturnType<typeof useDatabaseMutations>;
  onOpenRow: (row: DbRow) => void;
  onLayoutChange: (layout: CommanderLayout) => void;
}) {
  const fields = useCommanderFields(data.fields, view);
  const [creating, setCreating] = useState(false);
  const layout = view.config.options?.commanderLayout ?? 'default';
  /** Eslabón desplegado. Uno cada vez: el hilo se lee de arriba abajo. */
  const [openRowId, setOpenRowId] = useState<string | null>(null);

  const addLink = async (parentId?: string, inherited?: PageProperties) => {
    setCreating(true);
    try {
      const row = await mutations.addRow.mutateAsync(undefined);
      // La página se crea aquí, en el mismo gesto, y no de forma perezosa al
      // pintar cada eslabón: así nunca hay N mutaciones disparándose solas al
      // abrir un hilo antiguo.
      const prepared = await mutations.openRowPage.mutateAsync(row.id);
      // Nace en «Borrador» y no sin estado: una comanda a medio escribir es un
      // estado real del hilo, y es lo que distingue en la vista Table lo que
      // falta por enviar de lo que se envió y no ha respondido.
      const draft = fields.state?.options?.choices?.find((choice) => choice.label === 'Borrador');
      if (fields.state && draft) {
        await mutations.updateCell.mutateAsync({ rowId: row.id, fieldId: fields.state.id, value: draft.id });
      }
      if (fields.parent && parentId) {
        await mutations.updateCell.mutateAsync({ rowId: row.id, fieldId: fields.parent.id, value: parentId });
      }
      if (inherited) {
        await pageService.update(prepared.pageId, { properties: inheritableHeader(inherited) });
      }
      setOpenRowId(row.id);
    } finally {
      setCreating(false);
    }
  };

  const treeRows = useMemo(
    () => buildCommanderTree(data.rows, fields.parent?.id),
    [data.rows, fields.parent?.id],
  );

  useEffect(() => {
    if (layout !== 'protocol' || data.rows.length === 0) return;
    if (!openRowId || !data.rows.some((row) => row.id === openRowId)) {
      setOpenRowId(data.rows[data.rows.length - 1]!.id);
    }
  }, [layout, data.rows, openRowId]);

  const formatOptions = [
    { value: 'default', label: 'Hilo', icon: Workflow },
    { value: 'tree', label: 'Árbol', icon: GitBranch },
    { value: 'chain', label: 'Cadena S', icon: Link2 },
    { value: 'protocol', label: 'Protocolo', icon: PanelTop },
  ] as const;

  const item = (row: DbRow, index: number, depth = 0, last = index === data.rows.length - 1) => (
    <ThreadLink
      key={row.id}
      row={row}
      fields={fields}
      mutations={mutations}
      last={last}
      index={index}
      depth={depth}
      layout={layout}
      open={openRowId === row.id || layout === 'protocol'}
      onToggle={() => setOpenRowId((current) => (current === row.id ? null : row.id))}
      onOpenRow={() => onOpenRow(row)}
      onEvolve={(properties) => addLink(row.id, properties)}
    />
  );

  const activeProtocolRow = data.rows.find((row) => row.id === openRowId) ?? data.rows[data.rows.length - 1];

  return (
    <div className="atlas-thread pb-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-2">
        <div role="group" aria-label="Formato de Commander" className="atlas-commander-layout-switch">
          {formatOptions.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              aria-pressed={layout === value}
              title={label}
              onClick={() => onLayoutChange(value)}
              className={cn('atlas-commander-layout-button', layout === value && 'atlas-commander-layout-button-active')}
            >
              <Icon size={13} /><span>{label}</span>
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted">
          {data.rows.length} {data.rows.length === 1 ? 'comanda' : 'comandas'}
        </span>
      </div>

      {data.rows.length === 0 && (
        <p className="px-2 pb-3 text-sm text-muted">
          Sin comandas todavía. Pulsa <b className="font-medium text-fg">+</b> para escribir la
          primera y enviarla a Karajan.
        </p>
      )}

      {layout === 'default' && <ol className="space-y-0">{data.rows.map((row, index) => item(row, index))}</ol>}

      {layout === 'tree' && (
        <ol className="atlas-commander-tree">
          {treeRows.map(({ row, depth }, index) => item(row, index, depth, index === treeRows.length - 1))}
        </ol>
      )}

      {layout === 'chain' && (
        <ol className="atlas-commander-chain">
          {data.rows.map((row, index) => item(row, index))}
        </ol>
      )}

      {layout === 'protocol' && data.rows.length > 0 && (
        <div className="atlas-commander-protocol">
          <nav aria-label="Iteraciones del protocolo" className="atlas-commander-protocol-nav">
            {data.rows.map((row, index) => (
              <button
                key={row.id}
                type="button"
                aria-current={row.id === activeProtocolRow?.id ? 'step' : undefined}
                onClick={() => setOpenRowId(row.id)}
                className={cn(
                  'atlas-commander-protocol-step',
                  row.id === activeProtocolRow?.id && 'atlas-commander-protocol-step-active',
                )}
              >
                <span>{index + 1}</span>
                <b>{compactLabel(row, fields)}</b>
              </button>
            ))}
          </nav>
          {activeProtocolRow && <ol>{item(activeProtocolRow, data.rows.indexOf(activeProtocolRow), 0, true)}</ol>}
        </div>
      )}

      <div className="flex items-center gap-2 pl-[0.4375rem]">
        {/* El tramo de línea que baja hasta el «+»: es lo que hace leer el botón
            como «un eslabón más», y no como un botón suelto bajo una lista. */}
        <span className="h-6 w-px shrink-0 bg-border" aria-hidden="true" />
        <button
          type="button"
          onClick={() => addLink()}
          disabled={creating}
          className="flex items-center gap-1.5 rounded-atlas-sm px-2 py-1.5 text-xs text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-60"
        >
          {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          Añadir comanda
        </button>
      </div>
    </div>
  );
}

/** Las columnas a las que proyecta el eslabón, resueltas por id desde la vista. */
interface CommanderFields {
  title?: DbField;
  state?: DbField;
  repo?: DbField;
  mode?: DbField;
  task?: DbField;
  sent?: DbField;
  parent?: DbField;
}

function useCommanderFields(fields: DbField[], view: DatabaseView): CommanderFields {
  const options = view.config.options ?? {};
  return useMemo(() => {
    const byId = (id?: string) => (id ? fields.find((field) => field.id === id) : undefined);
    return {
      title: fields.find((field) => field.type === 'text'),
      state: byId(options.commanderStateFieldId),
      repo: byId(options.commanderRepoFieldId),
      mode: byId(options.commanderModeFieldId),
      task: byId(options.commanderTaskFieldId),
      sent: byId(options.commanderSentFieldId),
      parent: byId(options.commanderParentFieldId),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, options.commanderStateFieldId, options.commanderRepoFieldId, options.commanderModeFieldId, options.commanderTaskFieldId, options.commanderSentFieldId, options.commanderParentFieldId]);
}

function ThreadLink({
  row,
  fields,
  mutations,
  last,
  index,
  depth,
  layout,
  open,
  onToggle,
  onOpenRow,
  onEvolve,
}: {
  row: DbRow;
  fields: CommanderFields;
  mutations: ReturnType<typeof useDatabaseMutations>;
  last: boolean;
  index: number;
  depth: number;
  layout: CommanderLayout;
  open: boolean;
  onToggle: () => void;
  onOpenRow: () => void;
  onEvolve: (properties: PageProperties) => Promise<void>;
}) {
  const state = cellText(row.data[fields.state?.id ?? ''], fields.state);
  const task = String(row.data[fields.task?.id ?? ''] ?? '');
  const repo = cellText(row.data[fields.repo?.id ?? ''], fields.repo);
  const mode = cellText(row.data[fields.mode?.id ?? ''], fields.mode);
  const sent = String(row.data[fields.sent?.id ?? ''] ?? '');
  const preview = docToText(row.page_content).split('\n').find(Boolean) ?? '';
  const title = cellText(row.data[fields.title?.id ?? ''], fields.title);

  return (
    <li
      className={cn(
        'atlas-commander-link relative flex gap-3',
        layout === 'tree' && 'atlas-commander-link-tree',
        layout === 'tree' && depth === 0 && 'atlas-commander-link-tree-root',
        layout === 'chain' && 'atlas-commander-link-chain',
        layout === 'chain' && (index % 2 === 0 ? 'atlas-commander-link-chain-left' : 'atlas-commander-link-chain-right'),
        layout === 'protocol' && 'atlas-commander-link-protocol',
      )}
      style={layout === 'tree' ? { '--commander-depth': Math.min(depth, 8) } as React.CSSProperties : undefined}
    >
      {/* Raíl: punto del eslabón y línea de continuidad hacia el siguiente. */}
      <div className="atlas-commander-rail flex w-4 shrink-0 flex-col items-center pt-3">
        <span
          className={cn('h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-bg', dotClass(state))}
          aria-hidden="true"
        />
        {!last && layout !== 'chain' && <span className="w-px flex-1 bg-border" aria-hidden="true" />}
      </div>

      <div className={cn('min-w-0 flex-1', last ? 'pb-1' : 'pb-3')}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="group flex w-full min-w-0 items-start gap-2 rounded-atlas-sm px-2 py-1.5 text-left hover:bg-surface/60"
        >
          <ChevronRight
            size={13}
            className={cn('mt-0.5 shrink-0 text-muted transition-transform', open && 'rotate-90')}
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {task ? (
                <code className="text-[11px] text-fg">{task}</code>
              ) : (
                <span className="text-[11px] text-muted">sin enviar</span>
              )}
              {state && <Badge tone={toneFor(state)}>{state}</Badge>}
              {repo && <span className="text-[11px] text-muted">{repo}</span>}
              {mode && <span className="text-[11px] text-muted">{mode}</span>}
              {sent && (
                <span className="ml-auto shrink-0 text-[10px] text-muted">{formatDate(sent)}</span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-sm text-fg">
              {preview || title || <span className="italic text-muted">Comanda vacía</span>}
            </span>
          </span>
        </button>

        {open && (
          <div className="mt-1 rounded-atlas border border-border bg-raised p-3">
            {row.page_id ? (
              <CommandLink
                pageId={row.page_id}
                row={row}
                fields={fields}
                mutations={mutations}
                onOpenRow={onOpenRow}
                evolveLabel={
                  layout === 'tree'
                    ? 'Crear rama'
                    : layout === 'chain'
                      ? 'Continuar cadena'
                      : layout === 'protocol'
                        ? 'Nueva iteración'
                        : 'Evolucionar'
                }
                onEvolve={onEvolve}
              />
            ) : (
              <UnpreparedLink rowId={row.id} mutations={mutations} />
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Fila sin página detrás — creada desde la vista Table, donde «New» no pasa por
 * el hilo. Se prepara con un clic en vez de crearse sola al pintar: una mutación
 * disparada por un render es indistinguible de un fallo cuando falla.
 */
function UnpreparedLink({
  rowId,
  mutations,
}: {
  rowId: string;
  mutations: ReturnType<typeof useDatabaseMutations>;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span>Esta fila todavía no tiene comanda.</span>
      <button
        type="button"
        onClick={() => mutations.openRowPage.mutate(rowId)}
        disabled={mutations.openRowPage.isPending}
        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-fg hover:bg-surface disabled:opacity-60"
      >
        {mutations.openRowPage.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
        Preparar
      </button>
    </div>
  );
}

/**
 * El eslabón desplegado: Header Protocol, cuerpo del prompt y envío.
 *
 * Es donde se montan las consultas de página y de flujo — solo aquí, porque solo
 * aquí se necesitan.
 */
function CommandLink({
  pageId,
  row,
  fields,
  mutations,
  onOpenRow,
  evolveLabel,
  onEvolve,
}: {
  pageId: string;
  row: DbRow;
  fields: CommanderFields;
  mutations: ReturnType<typeof useDatabaseMutations>;
  onOpenRow: () => void;
  evolveLabel: string;
  onEvolve: (properties: PageProperties) => Promise<void>;
}) {
  const navigate = useNavigate();
  const { data: page } = usePage(pageId);
  const { mutateAsync: updatePage } = useUpdatePage(pageId);
  const flow = usePageFlow(pageId, 'karajan');
  const { addons } = useInstalledAddons();
  const project = useProjection(row, fields, mutations);
  const header = useHeaderProtocol(pageId);
  const delegate = useDelegateInKarajan();
  const approveReview = useApproveReviewInKarajan();
  const documentator = isDocumentadorProperties(page?.properties);
  const documentatorMutations = useDocumentatorMutations(pageId);
  const [result, setResult] = useState<KarajanDelegation | null>(null);
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);

  /**
   * Un eslabón nace con su Header Protocol puesto.
   *
   * La siembra es la misma que la del bloque en una nota (`insert()`): crea las
   * filas del esquema con su tipo y acuña los `generated` —fecha, id de tarea,
   * proyecto—. Sin esto, cada comanda empezaría con una rejilla vacía y habría
   * que añadir las ocho propiedades a mano, que es justo el trabajo que el
   * bloque existe para ahorrar.
   *
   * Espera a `ready`: aquí nadie pulsa un botón, así que el efecto llegaría antes
   * que el catálogo de parámetros y sembraría **nada** dejándolo por sembrado.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !header.available || !header.ready || header.shown) return;
    seeded.current = true;
    header.insert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header.available, header.ready, header.shown]);

  const entries = flow.data?.entries ?? [];
  /** El flujo llega en orden descendente: el primero es el último envío. */
  const latest = entries[0];
  const original = entries[entries.length - 1];
  const sent = entries.length > 0;

  const [body, setBody] = useState('');
  const [fixText, setFixText] = useState('');
  const [fixKeys, setFixKeys] = useState<string[]>([]);
  const [fixing, setFixing] = useState(false);

  const stored = docToText(page?.content ?? null);
  useEffect(() => setBody(stored), [pageId, stored]);

  /**
   * El cuerpo se edita como texto plano. Si la página trae algo que no son
   * párrafos —porque se abrió en el workspace y se editó con el editor
   * completo— no se ofrece el textarea: guardarlo desde aquí borraría ese
   * contenido sin decirlo.
   */
  const rich = page ? !isPlainDoc(page.content ?? null) : false;

  /** Estado vivo → proyección. Es lo que mantiene al día la vista Table. */
  useEffect(() => {
    if (!latest) return;
    const next = stateLabel(latest.state?.status);
    if (next && next !== cellText(row.data[fields.state?.id ?? ''], fields.state)) {
      void project({ state: next });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.state?.status]);

  const saveBody = () => {
    if (rich || body === stored) return;
    updatePage({
      content: textToDoc(body),
      // El título de la página proyecta solo al campo título de la fila (lo hace
      // el servidor), así que la primera línea del prompt acaba en la columna
      // `Comanda` sin escribirla dos veces.
      title: body.split('\n').find(Boolean)?.slice(0, 120) || 'Sin título',
    });
  };

  const startFix = () => {
    setFixing(true);
    setFixText('');
    setFixKeys([]);
  };

  /**
   * `classify` solo clasifica: sin delegar a continuación, el eslabón se
   * quedaría en «Enviado» para siempre porque nada más en Karajan lo ejecuta
   * (ver [[atlas.logica-motores-addons]] para el porqué del timeout largo en
   * esta acción). Delegar aquí es lo que hace que enviar una comanda la
   * ejecute de verdad, y no solo la registre.
   */
  const afterSend = async (taskId: string) => {
    setResult(null);
    setReviewTaskId(null);
    const detectedRepo = propertyText(page?.properties, 'repositorio') || detectRepositoryFromPrompt(body);
    if (!propertyText(page?.properties, 'repositorio') && detectedRepo) {
      await updatePage({
        properties: {
          ...(page?.properties ?? {}),
          repositorio: { type: 'select', value: detectedRepo },
        },
      });
    }
    await project({
      task: taskId,
      state: 'Ejecutando',
      ...(sent ? {} : { sent: new Date().toISOString().slice(0, 10) }),
      repo: detectedRepo,
      mode: propertyList(page?.properties, 'modo_ejecucion'),
    });
    setFixing(false);
    try {
      if (documentator) {
        const repository = documentatorRepository(detectedRepo);
        if (!repository) throw new Error('Selecciona Atlas, Karajan o naityer_setup en Repository.');
        await documentatorMutations.start.mutateAsync({ taskId, prompt: body, repository });
        await project({ state: 'Esperando ChatGPT' });
        return;
      }
      const task = await delegate.mutateAsync({ taskId });
      await applyDelegationResult(task);
    } catch {
      // El eslabón se queda «Ejecutando»: no sabemos si Karajan de verdad
      // falló o solo tardó más que el canal. El histórico de Karajan es la
      // fuente de verdad, no una adivinanza aquí.
    }
  };

  /**
   * Refleja lo que Karajan devolvió de verdad tras `delegate`/`approve-review`.
   *
   * `delegate-task` responde «delegated» con `executions: []` cuando la puerta
   * de revisión humana retiene la tarea (`requires_human_review`): no ejecutó
   * nada. Confundir eso con «Completado» —que es lo que pasaría con
   * `status !== 'failed' ? 'Completado' : 'Fallido'`— le diría al usuario que
   * el código ya existe cuando en realidad sigue sin arrancar.
   */
  const applyDelegationResult = async (task: KarajanTask) => {
    setResult(task.delegation ?? null);
    if (isReviewBlocked(task)) {
      setReviewTaskId(task.task_id);
      return; // Estado se queda «Ejecutando»: sigue pendiente, no completado.
    }
    setReviewTaskId(null);
    if (task.status === 'completed') await project({ state: 'Completado' });
    else if (task.status === 'failed') await project({ state: 'Fallido' });
    // `queued`/otros: se deja «Ejecutando» — el poll de `usePageFlow` lo resolverá.
  };

  const approve = async () => {
    if (!reviewTaskId) return;
    const task = await approveReview.mutateAsync({ taskId: reviewTaskId });
    await applyDelegationResult(task);
  };

  return (
    <div className="space-y-3">
      {!header.available && (
        <p className="text-[11px] leading-snug text-muted">
          Sin <span className="font-medium text-fg">audit_code</span> instalado la cabecera nace
          vacía: es su vocabulario —comandos, modelo, esfuerzo, skills— el que da sentido a estas
          propiedades. Puedes añadirlas a mano.
        </p>
      )}

      <PageProtocolPanel
        pageId={pageId}
        embedded
        defaultOpen={!sent}
        {...(fixing ? { fix: { selected: fixKeys, onToggle: toggleIn(setFixKeys) } } : {})}
        send={
          <div className="space-y-2">
            {fixing && (
              <textarea
                autoFocus
                value={fixText}
                onChange={(event) => setFixText(event.target.value)}
                rows={3}
                placeholder="Qué hay que corregir…"
                className="w-full resize-y rounded-atlas-sm border border-border bg-bg px-2 py-1.5 text-sm outline-none placeholder:text-muted focus:border-accent"
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <SendToKarajan
                pageId={pageId}
                prompt={fixing ? fixPrompt(fixText, latest?.taskId) : body}
                label={fixing ? 'Reenviar fix' : 'Enviar a Karajan'}
                {...(fixing
                  ? {
                      only: fixKeys,
                      // Karajan descarta hoy los `params` que no conoce, así que la
                      // referencia va también en el texto del prompt. El día que
                      // acepte `params`, esto empieza a funcionar estructurado sin
                      // tocar nada (misma degradación que el resto del protocolo).
                      base: { header: { fixOf: latest?.taskId ?? null } },
                    }
                  : {})}
                onSent={(task) => void afterSend(task.task_id)}
              />
              {fixing && (
                <button
                  type="button"
                  onClick={() => setFixing(false)}
                  className="text-xs text-muted hover:text-fg"
                >
                  Cancelar
                </button>
              )}
            </div>
          </div>
        }
      />

      {/* El cuerpo. Enviado, es un hecho y no se edita: corregirlo en sitio
          dejaría el registro mintiendo sobre lo que Karajan recibió. */}
      {sent || rich ? (
        <div className="whitespace-pre-wrap rounded-atlas-sm bg-surface/60 px-3 py-2 text-sm text-fg">
          {(original?.prompt ?? stored) || <span className="italic text-muted">Sin cuerpo</span>}
        </div>
      ) : (
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onBlur={saveBody}
          rows={4}
          placeholder="Escribe la comanda…"
          className="w-full resize-y rounded-atlas-sm border border-border bg-bg px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
        />
      )}

      {(delegate.isPending || approveReview.isPending) && (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Loader2 size={12} className="animate-spin" /> Ejecutando en Karajan…
        </p>
      )}

      {reviewTaskId && !approveReview.isPending && (
        <div className="flex flex-wrap items-center gap-2 rounded-atlas-sm border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-fg">
          <span>
            Karajan retiene esta tarea: requiere revisión humana antes de ejecutar nada.
          </span>
          <button
            type="button"
            onClick={() => void approve()}
            className="ml-auto shrink-0 rounded border border-border px-2 py-1 font-medium hover:bg-surface"
          >
            Aprobar y ejecutar
          </button>
        </div>
      )}

      {result && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted">Resultado</p>
          {result.executions.map((execution) => (
            <div
              key={execution.subtask_id}
              className="whitespace-pre-wrap rounded-atlas-sm border border-border bg-surface/60 px-3 py-2 font-mono text-xs text-fg"
            >
              <div className="mb-1 flex flex-wrap items-center gap-2 font-sans text-[11px] text-muted">
                <Badge tone={execution.error ? 'danger' : 'success'}>{execution.status}</Badge>
                <span>{execution.model_used}</span>
              </div>
              {execution.error ?? execution.output ?? <span className="italic text-muted">Sin salida</span>}
            </div>
          ))}
        </div>
      )}

      {documentator && <DocumentatorHandoff pageId={pageId} />}

      {entries.length > 1 && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted">Envíos de esta comanda</p>
          {/* En orden cronológico —el flujo llega del más nuevo al más viejo—
              para que la cadena de fixes se lea como ocurrió. */}
          <ul className="space-y-1 border-l border-border pl-3">
            {[...entries].reverse().map((entry, index) => (
              <RevisionRow key={entry.id} entry={entry} original={index === 0} />
            ))}
          </ul>
        </div>
      )}

      {flow.data?.addonOffline && (
        <p className="text-[11px] text-muted">
          Karajan no responde: se muestra el histórico guardado, sin el estado actual.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1 border-t border-border pt-2">
        {sent && !fixing && (
          <button
            type="button"
            onClick={startFix}
            title="Reabrir la comanda para corregir solo algunos elementos"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted hover:bg-surface hover:text-fg"
          >
            <Wrench size={13} /> Fixear
          </button>
        )}
        <button
          type="button"
          onClick={() => void onEvolve(page?.properties ?? {})}
          disabled={!page || mutations.addRow.isPending}
          title="Crea una comanda descendiente con los parámetros editables de este Header Protocol"
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted hover:bg-surface hover:text-fg disabled:opacity-50"
        >
          <RotateCcw size={13} /> {evolveLabel}
        </button>
        <button
          type="button"
          onClick={() => {
            // El repositorio elegido decide a qué aplicación pasa a pertenecer la
            // página. Si no resuelve a ninguna instalada, se abre igual como nota
            // normal: un valor escrito a mano no debe romper la navegación.
            const addonId = resolveAddon(propertyText(page?.properties, 'repositorio'), addons);
            if (addonId && page?.ad
```
_(archivo truncado por tamano)_
