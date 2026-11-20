"""Cribado reproducible y de solo lectura de Biblioteca; no instala ni ejecuta skills.

python scripts/analizar_especialistas.py --db /ruta/resources.db --casa /ruta/usuario
La salida pública no contiene rutas personales ni cuerpos de skills.
"""
import argparse
import collections
import hashlib
import json
import re
import sqlite3
from pathlib import Path


def analizar(db: Path, casa: Path, salida: Path):
    repo = Path(__file__).resolve().parents[1]
    codigo = (repo / 'atlas/src/especialistas-catalogo.ts').read_text(encoding='utf-8')
    patrones = re.findall(r"definir\('([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)'\)", codigo)
    paquetes = [{'id': i, 'nombre': n, 'ambito': a, 'skills': s.split(','), 'terminos': t.split(',')} for i, n, a, s, t in patrones]
    locales = collections.defaultdict(set)
    for proveedor, carpeta in [('claude', '.claude'), ('codex', '.codex'), ('agents', '.agents')]:
        for estado, raiz in [('instalada', casa / carpeta / 'skills'), ('almacen', casa / '.karajan/skills-almacen' / proveedor)]:
            if not raiz.exists():
                continue
            for d in raiz.iterdir():
                if not d.name.startswith(('.', '_', 'source-command-')) and not d.name.endswith('.disabled') and (d / 'SKILL.md').is_file():
                    locales[d.name.lower()].add(f'{proveedor}:{estado}')
    uri = db.resolve().as_uri() + '?mode=ro&immutable=1'
    con = sqlite3.connect(uri, uri=True)
    rows = con.execute("select slug,name,source_url,summary,metadata_json from resources where kind='skill' and index_status='active' order by slug").fetchall()
    con.close()
    relaciones = collections.defaultdict(list)
    for p in paquetes:
        for s in p['skills']:
            relaciones[s].append(p['id'])
    registros = []
    vistas = {}
    for slug, nombre, fuente, resumen, metadata in rows:
        meta = json.loads(metadata or '{}')
        ruta = meta.get('skill_path', '')
        ident = Path(ruta).parent.name.lower() if ruta else slug.split('--')[-1].lower()
        fuente = fuente or meta.get('provenance', {}).get('canonical_url', '')
        clave = fuente.lower().rstrip('/') if fuente else slug
        grupos = relaciones.get(ident, []) or relaciones.get('gstack-' + ident, [])
        if re.search(r'(^|/)(tests?|fixtures?)/', ruta):
            estado, motivo = 'excluida_fixture', 'El recurso procede de pruebas; no acredita cobertura funcional.'
        elif ident in ('template', 'template-skill'):
            estado, motivo = 'excluida_plantilla', 'Plantilla, no una capacidad especializada implementada.'
        elif clave in vistas:
            estado, motivo = 'duplicada', 'Misma referencia de origen que ' + vistas[clave]
        elif grupos:
            estado, motivo = 'paquete_propuesto', 'La identidad participa en los paquetes indicados; comprobar cobertura local y requisitos antes de ejecutar.'
        elif not ruta:
            estado, motivo = 'referencia_por_verificar', 'Referencia a colección o recurso sin SKILL.md individual verificado en esta instantánea; no cuenta como cobertura.'
        else:
            estado, motivo = 'fuera_paquete_inicial', 'Skill individual indexada, sin flujo complementario validado en el catálogo inicial; se conserva como sugerencia suelta.'
        vistas.setdefault(clave, slug)
        registros.append({'slug': slug, 'nombre': nombre, 'identidad': ident, 'fuente': fuente, 'ruta_fuente': ruta, 'estado': estado, 'motivo': motivo, 'especialistas': grupos})
    for p in paquetes:
        p['cobertura'] = [{'skill': s, 'ubicaciones': sorted(locales.get(s, [])), 'fuentes': [r['slug'] for r in registros if r['identidad'] == s or (s.startswith('gstack-') and r['identidad'] == s[7:])]} for s in p['skills']]
        p['faltan'] = [s for s in p['skills'] if not locales.get(s)]
        p['estado'] = 'cobertura_local' if not p['faltan'] else 'pendiente_skills'
        p['requisitos_herramientas'] = 'No verificados: los requisitos de cada SKILL.md siguen vigentes; cobertura local no acredita herramientas, cuentas, GPU ni servicios.'
    salida.mkdir(parents=True, exist_ok=True)
    artefacto = {'version': 1, 'fuente': 'resources.db, lectura immutable sin WAL', 'total': len(registros), 'catalogo_sha256': hashlib.sha256(codigo.encode()).hexdigest(), 'recuentos': dict(collections.Counter(r['estado'] for r in registros)), 'paquetes': paquetes, 'entradas': registros}
    (salida / 'especialistas-inventario.json').write_text(json.dumps(artefacto, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    lineas = ['# Análisis de biblioteca para especialistas', '', 'Cribado de metadatos de todas las entradas activas de tipo skill, contrastado con carpetas locales y almacén. No es una auditoría de todos los cuerpos ni una prueba de desempeño de los modelos.', '', f"Entradas: **{len(registros)}**. Paquetes: **{len(paquetes)}**. Con cobertura local completa: **{sum(not p['faltan'] for p in paquetes)}**.", '', '## Criterio', '', 'Cada paquete delimita un flujo y reúne al menos dos skills distintas. Unas cubren pasos complementarios y otras ofrecen alternativas según formato, hardware o tipo de tarea. No deben ejecutarse todas indiscriminadamente. Los términos se usan para selección determinista; un empate conserva el flujo original. La presencia en Biblioteca no sustituye la disponibilidad de instrucciones locales.', '', 'Se descarta la taxonomía heredada como criterio suficiente: contiene asignaciones excesivamente amplias a pruebas/seguridad, incluso para recursos científicos. No se crean skills ni se obtienen recursos de red para completar paquetes.', '', '## Cribado completo', '', '| Estado | Entradas |', '| --- | ---: |']
    lineas += [f'| {k} | {v} |' for k, v in artefacto['recuentos'].items()]
    lineas += ['', 'Cada una de las entradas, sus fuentes, estado, motivo y pertenencias están en `especialistas-inventario.json`. «Fuera del paquete inicial» no desactiva ni elimina la skill: permanece disponible para sugerencias sueltas. Las referencias sin instrucciones verificadas tampoco se cuentan como cobertura. Se evita convertir traducciones o referencias duplicadas en especialidades adicionales.', '', '## Paquetes y motivo', '', '| Id | Flujo y motivo | Skills | Cobertura local |', '| --- | --- | --- | --- |']
    lineas += [f"| {p['id']} | {p['ambito']} | {', '.join(p['skills'])} | {'Completa' if not p['faltan'] else 'Faltan: ' + ', '.join(p['faltan'])} |" for p in paquetes]
    lineas += ['', '## Modelos y disponibilidad', '', 'Valores iniciales: Claude CLI → `sonnet`; Codex → `default` (modelo de la cuenta). Ambos son configurables por especialista; se conserva el proveedor que resuelven las políticas y la elección manual. Son valores compatibles con los ejecutores existentes, no conclusiones de un benchmark. No se afirma una mejora cuantificada de desempeño sin datos revisados de producción.', '', '## Reproducción y límites', '', 'Ejecutar `python scripts/analizar_especialistas.py --db <resources.db> --casa <usuario>`. La lectura inmutable usa la instantánea persistida, sin WAL. No modifica la base, instalaciones ni configuraciones. La salida evita rutas personales. El catálogo de ejecución es acotado y no relee esta instantánea por tarea.', '', 'Los paquetes científicos, de laboratorio, nube o plugins pueden necesitar bibliotecas, binarios, credenciales, hardware o servicios. La preparación de SKILL.md no acredita esos requisitos ni autoriza acciones externas. Se consultan las instrucciones y se comprueban los requisitos al realizar la tarea específica.', '']
    (salida / 'especialistas-analisis.md').write_text('\n'.join(lineas), encoding='utf-8')
    print(json.dumps({'entradas': len(registros), 'paquetes': len(paquetes), 'cobertura_local': sum(not p['faltan'] for p in paquetes), 'estados': artefacto['recuentos']}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True, type=Path)
    parser.add_argument('--casa', required=True, type=Path)
    parser.add_argument('--salida', default=Path(__file__).resolve().parents[1] / 'docs', type=Path)
    args = parser.parse_args()
    analizar(args.db, args.casa, args.salida)
