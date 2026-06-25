# KARAJAN - Reporte de pruebas

Ultimo reporte generado:

- [KARAJAN_TEST_REPORT_2026-06-25.md](/C:/Users/tiand/Desktop/karajan/docs/KARAJAN_TEST_REPORT_2026-06-25.md)

Ejecucion usada:

- `data/trial_reports/karajan_trials_20260625_195604.json`

Resumen:

- 3 pruebas ejecutadas contra `http://127.0.0.1:8001`.
- Backend en modo `simulated`.
- N1 completado como tarea simple.
- N2/N3 completado como tarea intermedia.
- N4/N5 delegado y bloqueado por puerta de revision humana, comportamiento esperado para tarea critica.
- Mejoras aplicadas despues del reporte: persistencia atomica del layout, fallback a backup si el JSON se corrompe, estado `policy_waiting` para bloqueos esperados por revision humana y coste de observabilidad alineado con `/metrics`.
