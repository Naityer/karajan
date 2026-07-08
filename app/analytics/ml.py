"""Predictive analytics over the Fase-1 run history (Fase 4).

Three XGBoost models trained on demand from the real `runs`/`tasks_v2`/legacy
`tasks` rows:

* `XGBClassifier`  — success (`status == 'completed'`) vs. failure.
* `XGBRegressor`   — `estimated_cost_usd`.
* `XGBRegressor`   — `latency_ms`.

Everything here is gated behind a **minimum-sample threshold** (`MIN_REQUIRED`
= 200 usable runs). Below it, XGBoost trivially overfits and any held-out
metric is noise, so `train_all()` refuses and every prediction path answers a
structured "not trained yet" instead of a fabricated number. The real
production DB currently sits well under this gate — that is the *expected*
state, not a failure.

Optional dependencies, degraded gracefully (same pattern as
`app/analytics/duckdb_ops.py` / `app/analysis/ts_analyzer.py`):

* `xgboost` — the models. Absent -> `MLUnavailable`.
* `duckdb`  — reused via `duckdb_ops._connect` for the feature pull. Absent ->
  `AnalyticsUnavailable` (surfaced as `MLUnavailable` by the callers here).

Anomaly detection is **dependency-light on purpose** (no scikit-learn / Isolation
Forest — the plan's constraint): a residual-based 3-sigma heuristic. During
training we record, per regression target, the standard deviation of the
model's residuals on the training rows and the target's own mean/std. A value
is flagged anomalous when it lies more than `N_SIGMA` (default 3) standard
deviations away from the reference — see `flag_anomaly` / `detect_anomalies`.

Categorical features are ordinal-encoded against a vocabulary learned at train
time and persisted in a JSON sidecar (`meta_v1.json`) next to the models, so
prediction-time inputs are encoded with the exact same mapping (unseen category
-> a reserved "unknown" bucket).
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.analytics import duckdb_ops
from app.analytics.duckdb_ops import AnalyticsUnavailable
from app.database import DEFAULT_DB_PATH

try:  # optional dependency — every ML path degrades to MLUnavailable if absent
    import numpy as np
    import xgboost as xgb

    XGBOOST_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised via monkeypatch in tests
    np = None  # type: ignore[assignment]
    xgb = None  # type: ignore[assignment]
    XGBOOST_AVAILABLE = False


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MIN_REQUIRED = 200
N_SIGMA = 3.0
_SEED = 42
_HOLDOUT_FRAC = 0.2

MODEL_DIR = Path("data/models")
MODEL_FILES = {
    "success": "success_v1.json",
    "cost": "cost_v1.json",
    "latency": "latency_v1.json",
}
META_FILE = "meta_v1.json"

# Feature layout. Numeric features are used as-is; categorical features are
# ordinal-encoded and appended (in this order) after the numeric block.
NUMERIC_FEATURES = [
    "ambiguity",
    "context_required",
    "reasoning_depth",
    "autonomy_required",
    "operational_risk",
    "validation_difficulty",
    "complexity_score",
    "prompt_length",
    "subtask_count",
]
CATEGORICAL_FEATURES = [
    "task_type",
    "domain",
    "intent",
    "provider_name",
    "model_id",
    "backend",
]
FEATURE_ORDER = NUMERIC_FEATURES + CATEGORICAL_FEATURES

# A run "counts" toward training only once it has terminated (success or
# failure). Still-`running`/`queued` rows carry no outcome to learn from.
_USABLE_STATUSES = ("completed", "failed")


class MLUnavailable(RuntimeError):
    """Raised when the predictive layer cannot run (xgboost/duckdb absent)."""


class NotEnoughData(RuntimeError):
    """Raised when training is attempted below the `MIN_REQUIRED` sample gate.

    Carries the structured readiness payload so the API layer can echo the
    exact `{trained, samples, min_required}` shape to the caller.
    """

    def __init__(self, readiness: dict[str, Any]) -> None:
        self.readiness = readiness
        super().__init__(
            f"not enough data to train: {readiness['samples']} usable runs, "
            f"need >= {readiness['min_required']}"
        )


class ModelNotTrained(RuntimeError):
    """Raised when a prediction is requested but no trained model exists yet."""


def _require_xgboost() -> None:
    if not XGBOOST_AVAILABLE:
        raise MLUnavailable(
            "xgboost is not installed — install the optional 'xgboost' extra "
            "(see requirements.txt) to enable predictive analytics"
        )


def _model_dir(db_path: Path | str = DEFAULT_DB_PATH) -> Path:
    """Model directory, co-located with the DB file's parent `data/` dir.

    Keeping the models next to the DB they were trained on means a test using a
    `tmp_path` DB writes its models into an isolated `tmp_path/models/` dir and
    never clobbers the real `data/models/`.
    """
    return Path(db_path).resolve().parent / "models"


# ---------------------------------------------------------------------------
# Feature engineering
# ---------------------------------------------------------------------------


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _row_to_features(row: dict[str, Any]) -> dict[str, Any]:
    """Project one joined DB row into the flat feature dict used everywhere.

    `classification_json` (from the legacy `tasks` table) holds the original
    `CriteriaScores` sub-scores, `domain` (a list), `intent`, `complexity_score`
    and `subtasks`. `domain` is encoded as its FIRST element (a deterministic,
    low-cardinality choice; a task's primary domain dominates its routing).
    """
    classification: dict[str, Any] = {}
    raw = row.get("classification_json")
    if raw:
        try:
            classification = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            classification = {}
    criteria = classification.get("criteria") or {}
    domain_list = classification.get("domain") or []
    domain = domain_list[0] if isinstance(domain_list, list) and domain_list else "general"
    subtasks = classification.get("subtasks") or []
    prompt = row.get("prompt") or ""
    task_type = row.get("task_type") or classification.get("intent") or "unknown"

    return {
        # numeric — criteria sub-scores
        "ambiguity": _to_float(criteria.get("ambiguity")),
        "context_required": _to_float(criteria.get("context_required")),
        "reasoning_depth": _to_float(criteria.get("reasoning_depth")),
        "autonomy_required": _to_float(criteria.get("autonomy_required")),
        "operational_risk": _to_float(criteria.get("operational_risk")),
        "validation_difficulty": _to_float(criteria.get("validation_difficulty")),
        "complexity_score": _to_float(classification.get("complexity_score")),
        "prompt_length": float(len(prompt)),
        "subtask_count": float(len(subtasks) if isinstance(subtasks, list) else 0),
        # categorical
        "task_type": str(task_type),
        "domain": str(domain),
        "intent": str(classification.get("intent") or "unknown"),
        "provider_name": str(row.get("provider_name") or "unknown"),
        "model_id": str(row.get("model_id") or "unknown"),
        "backend": str(row.get("backend") or "unknown"),
    }


def build_feature_frame(db_path: Path | str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """Pull training-ready rows: `runs` JOIN `tasks_v2` JOIN legacy `tasks`.

    Reuses the Fase-3 DuckDB `_connect` helper (READ_ONLY attach) so this reader
    can never take a write lock on the SQLite file. Only terminated runs
    (`_USABLE_STATUSES`) with a non-null latency and cost are returned — a run
    without those has no regression target to learn from.

    Each element carries the flat feature dict plus the three targets:
    `success` (1/0), `cost` (usd), `latency` (ms).
    """
    con = duckdb_ops._connect(db_path)
    try:
        cur = con.execute(
            f"""
            SELECT
                r.provider_name        AS provider_name,
                r.model_id             AS model_id,
                r.backend              AS backend,
                r.status               AS status,
                r.latency_ms           AS latency_ms,
                r.estimated_cost_usd   AS estimated_cost_usd,
                tv2.task_type          AS task_type,
                t.prompt               AS prompt,
                t.classification_json  AS classification_json
            FROM tl.runs r
            LEFT JOIN tl.tasks_v2 tv2 ON tv2.legacy_task_id = r.task_id
            LEFT JOIN tl.tasks t      ON t.task_id = r.task_id
            WHERE r.status IN {_USABLE_STATUSES}
              AND r.latency_ms IS NOT NULL
              AND r.estimated_cost_usd IS NOT NULL
            """
        )
        columns = [d[0] for d in cur.description]
        rows = [dict(zip(columns, values)) for values in cur.fetchall()]
    finally:
        con.close()

    frame: list[dict[str, Any]] = []
    for row in rows:
        features = _row_to_features(row)
        features["success"] = 1 if row.get("status") == "completed" else 0
        features["cost"] = _to_float(row.get("estimated_cost_usd"))
        features["latency"] = _to_float(row.get("latency_ms"))
        frame.append(features)
    return frame


# ---------------------------------------------------------------------------
# Sample gate
# ---------------------------------------------------------------------------


def _count_usable(db_path: Path | str = DEFAULT_DB_PATH) -> int:
    """Count usable (terminated, non-null cost+latency) runs via plain sqlite3.

    Deliberately does NOT go through DuckDB: the readiness gate must answer even
    on a machine without the optional `duckdb` extra installed.
    """
    import sqlite3

    placeholders = ",".join("?" for _ in _USABLE_STATUSES)
    conn = sqlite3.connect(str(Path(db_path)))
    try:
        try:
            row = conn.execute(
                f"""
                SELECT COUNT(*) FROM runs
                WHERE status IN ({placeholders})
                  AND latency_ms IS NOT NULL
                  AND estimated_cost_usd IS NOT NULL
                """,
                list(_USABLE_STATUSES),
            ).fetchone()
            return int(row[0]) if row else 0
        except sqlite3.DatabaseError:
            return 0
    finally:
        conn.close()


def training_readiness(db_path: Path | str = DEFAULT_DB_PATH) -> dict[str, Any]:
    """Report whether training is possible and whether a model already exists.

    `samples` = usable runs (status in completed/failed, with cost + latency).
    `trained` is True only when a persisted model bundle is present on disk.
    """
    samples = _count_usable(db_path)
    meta_path = _model_dir(db_path) / META_FILE
    return {
        "trained": meta_path.exists(),
        "samples": samples,
        "min_required": MIN_REQUIRED,
        "meets_gate": samples >= MIN_REQUIRED,
    }


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------


def _fit_encoders(frame: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Learn an ordinal vocabulary per categorical feature (sorted, stable)."""
    encoders: dict[str, list[str]] = {}
    for feature in CATEGORICAL_FEATURES:
        values = sorted({str(row[feature]) for row in frame})
        encoders[feature] = values
    return encoders


def _encode_value(feature: str, value: Any, encoders: dict[str, list[str]]) -> float:
    """Map a categorical value to its index; unseen -> reserved unknown bucket."""
    vocab = encoders.get(feature, [])
    try:
        return float(vocab.index(str(value)))
    except ValueError:
        return float(len(vocab))  # reserved "unknown" index


def _encode_row(features: dict[str, Any], encoders: dict[str, list[str]]) -> list[float]:
    vector = [_to_float(features.get(name)) for name in NUMERIC_FEATURES]
    for name in CATEGORICAL_FEATURES:
        vector.append(_encode_value(name, features.get(name), encoders))
    return vector


def _encode_frame(frame: list[dict[str, Any]], encoders: dict[str, list[str]]):
    return np.array([_encode_row(row, encoders) for row in frame], dtype=float)


# ---------------------------------------------------------------------------
# Anomaly heuristic (dependency-light, residual 3-sigma)
# ---------------------------------------------------------------------------


def flag_anomaly(value: float, reference_mean: float, reference_std: float, n_sigma: float = N_SIGMA) -> bool:
    """True when `value` deviates from `reference_mean` by > `n_sigma` stddevs.

    The single primitive behind both anomaly paths:
    * historical runs: `flag_anomaly(actual, predicted, residual_std)` — a run
      whose observed value is > N-sigma away from what the model predicted.
    * a fresh prediction: `flag_anomaly(predicted, target_mean, target_std)` —
      a predicted profile that is itself an outlier vs. the training targets.

    A non-positive std (degenerate/constant target) can never be anomalous.
    """
    if reference_std <= 0 or math.isnan(value):
        return False
    return abs(value - reference_mean) > n_sigma * reference_std


def _stats(values) -> dict[str, float]:
    arr = np.asarray(values, dtype=float)
    if arr.size == 0:
        return {"mean": 0.0, "std": 0.0}
    return {"mean": float(arr.mean()), "std": float(arr.std())}


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------


def _split_indices(n: int):
    """Deterministic 80/20 holdout split (seeded), no scikit-learn."""
    rng = np.random.default_rng(_SEED)
    order = rng.permutation(n)
    holdout = max(1, int(round(n * _HOLDOUT_FRAC)))
    test_idx = order[:holdout]
    train_idx = order[holdout:]
    if train_idx.size == 0:  # tiny n guard
        train_idx, test_idx = order, order
    return train_idx, test_idx


def _rmse(pred, actual) -> float:
    pred = np.asarray(pred, dtype=float)
    actual = np.asarray(actual, dtype=float)
    if pred.size == 0:
        return 0.0
    return float(np.sqrt(np.mean((pred - actual) ** 2)))


def _auc(y_true, y_score) -> float | None:
    """ROC-AUC via the Mann-Whitney U statistic (no scikit-learn)."""
    y_true = np.asarray(y_true)
    y_score = np.asarray(y_score, dtype=float)
    pos = y_score[y_true == 1]
    neg = y_score[y_true == 0]
    if pos.size == 0 or neg.size == 0:
        return None
    order = np.argsort(y_score, kind="mergesort")
    ranks = np.empty_like(order, dtype=float)
    ranks[order] = np.arange(1, y_score.size + 1)
    rank_sum_pos = ranks[y_true == 1].sum()
    u = rank_sum_pos - pos.size * (pos.size + 1) / 2.0
    return float(u / (pos.size * neg.size))


def train_all(db_path: Path | str = DEFAULT_DB_PATH) -> dict[str, Any]:
    """Train + persist the three models. Refuses below the sample gate.

    Returns a summary: samples used, per-model held-out metrics, the persisted
    file paths, and the anomaly reference stats. Raises `NotEnoughData` (with
    the readiness payload) below `MIN_REQUIRED`, `MLUnavailable` if xgboost is
    absent.
    """
    _require_xgboost()
    readiness = training_readiness(db_path)
    if not readiness["meets_gate"]:
        raise NotEnoughData(readiness)

    try:
        frame = build_feature_frame(db_path)
    except AnalyticsUnavailable as exc:
        raise MLUnavailable(str(exc)) from exc

    if len(frame) < MIN_REQUIRED:
        # The DuckDB feature pull applies the same filter as the sqlite count;
        # if they disagree (they should not), trust the stricter frame count.
        raise NotEnoughData({**readiness, "samples": len(frame), "meets_gate": False})

    encoders = _fit_encoders(frame)
    X = _encode_frame(frame, encoders)
    y_success = np.array([row["success"] for row in frame], dtype=int)
    y_cost = np.array([row["cost"] for row in frame], dtype=float)
    y_latency = np.array([row["latency"] for row in frame], dtype=float)

    train_idx, test_idx = _split_indices(len(frame))
    model_dir = _model_dir(db_path)
    model_dir.mkdir(parents=True, exist_ok=True)

    metrics: dict[str, Any] = {}
    anomaly_ref: dict[str, Any] = {}

    # --- success classifier -------------------------------------------------
    success_trained = False
    if len(np.unique(y_success)) >= 2:
        clf = xgb.XGBClassifier(
            n_estimators=60, max_depth=4, learning_rate=0.1,
            subsample=0.9, colsample_bytree=0.9, random_state=_SEED,
            eval_metric="logloss", tree_method="hist",
        )
        clf.fit(X[train_idx], y_success[train_idx])
        proba = clf.predict_proba(X[test_idx])[:, 1]
        preds = (proba >= 0.5).astype(int)
        metrics["success"] = {
            "accuracy": float(np.mean(preds == y_success[test_idx])),
            "auc": _auc(y_success[test_idx], proba),
            "positive_rate": float(np.mean(y_success)),
        }
        clf.save_model(str(model_dir / MODEL_FILES["success"]))
        success_trained = True
    else:
        metrics["success"] = {"skipped": "only one outcome class present"}

    # --- cost + latency regressors -----------------------------------------
    for name, y in (("cost", y_cost), ("latency", y_latency)):
        reg = xgb.XGBRegressor(
            n_estimators=80, max_depth=4, learning_rate=0.1,
            subsample=0.9, colsample_bytree=0.9, random_state=_SEED,
            tree_method="hist",
        )
        reg.fit(X[train_idx], y[train_idx])
        holdout_pred = reg.predict(X[test_idx])
        # Residuals over the TRAINING rows drive the anomaly reference (we want
        # the model's own fit error, not a holdout estimate that is noisier).
        train_pred = reg.predict(X[train_idx])
        residual_std = float(np.std(y[train_idx] - train_pred))
        target_stats = _stats(y)
        metrics[name] = {"rmse": _rmse(holdout_pred, y[test_idx])}
        anomaly_ref[name] = {
            "residual_std": residual_std,
            "target_mean": target_stats["mean"],
            "target_std": target_stats["std"],
        }
        reg.save_model(str(model_dir / MODEL_FILES[name]))

    meta = {
        "version": "v1",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "samples": len(frame),
        "min_required": MIN_REQUIRED,
        "n_sigma": N_SIGMA,
        "feature_order": FEATURE_ORDER,
        "numeric_features": NUMERIC_FEATURES,
        "categorical_features": CATEGORICAL_FEATURES,
        "encoders": encoders,
        "anomaly_ref": anomaly_ref,
        "metrics": metrics,
        "success_trained": success_trained,
    }
    (model_dir / META_FILE).write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return {
        "trained": True,
        "samples": len(frame),
        "min_required": MIN_REQUIRED,
        "metrics": metrics,
        "models": {name: str(model_dir / fname) for name, fname in MODEL_FILES.items()},
        "trained_at": meta["trained_at"],
    }


# ---------------------------------------------------------------------------
# Loading + prediction
# ---------------------------------------------------------------------------


def _load_meta(db_path: Path | str = DEFAULT_DB_PATH) -> dict[str, Any]:
    meta_path = _model_dir(db_path) / META_FILE
    if not meta_path.exists():
        raise ModelNotTrained("no trained model bundle found — call train_all() first")
    return json.loads(meta_path.read_text(encoding="utf-8"))


def _load_model(kind: str, cls, db_path: Path | str = DEFAULT_DB_PATH):
    path = _model_dir(db_path) / MODEL_FILES[kind]
    if not path.exists():
        return None
    model = cls()
    model.load_model(str(path))
    return model


def feature_importances(kind: str = "success", db_path: Path | str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """Return the trained model's feature importances, sorted descending.

    `kind` is one of `success` / `cost` / `latency`.
    """
    _require_xgboost()
    if kind not in MODEL_FILES:
        raise ValueError(f"kind must be one of {sorted(MODEL_FILES)}, got {kind!r}")
    meta = _load_meta(db_path)
    cls = xgb.XGBClassifier if kind == "success" else xgb.XGBRegressor
    model = _load_model(kind, cls, db_path)
    if model is None:
        raise ModelNotTrained(f"model '{kind}' was not trained (see meta.metrics)")
    importances = model.feature_importances_
    feature_order = meta["feature_order"]
    pairs = [
        {"feature": feature_order[i], "importance": float(importances[i])}
        for i in range(min(len(feature_order), len(importances)))
    ]
    pairs.sort(key=lambda item: item["importance"], reverse=True)
    return pairs


def predict(features: dict[str, Any], db_path: Path | str = DEFAULT_DB_PATH) -> dict[str, Any]:
    """Predict success prob / cost / latency for one draft task + anomaly flag.

    `features` is a flat dict (see `_row_to_features` keys); missing keys fall
    back to sane defaults via the encoder/`_to_float`. Raises `ModelNotTrained`
    if no bundle exists (the API layer turns that into a 503).
    """
    _require_xgboost()
    meta = _load_meta(db_path)
    encoders = meta["encoders"]
    x = np.array([_encode_row(features, encoders)], dtype=float)

    result: dict[str, Any] = {
        "predicted_success_prob": None,
        "predicted_cost_usd": None,
        "predicted_latency_ms": None,
        "is_anomaly": False,
        "top_features": [],
    }

    clf = _load_model("success", xgb.XGBClassifier, db_path) if meta.get("success_trained") else None
    if clf is not None:
        result["predicted_success_prob"] = float(clf.predict_proba(x)[0, 1])

    anomaly_ref = meta.get("anomaly_ref", {})
    anomaly = False
    for kind, out_key in (("cost", "predicted_cost_usd"), ("latency", "predicted_latency_ms")):
        model = _load_model(kind, xgb.XGBRegressor, db_path)
        if model is None:
            continue
        value = float(model.predict(x)[0])
        result[out_key] = value
        ref = anomaly_ref.get(kind, {})
        # A predicted profile is anomalous when it is itself an outlier vs. the
        # training target distribution (mean +/- N-sigma). Same primitive used
        # for historical residual checks in `detect_anomalies`.
        if flag_anomaly(value, ref.get("target_mean", 0.0), ref.get("target_std", 0.0), meta.get("n_sigma", N_SIGMA)):
            anomaly = True
    result["is_anomaly"] = anomaly

    # Top drivers: prefer the classifier's importances, else the cost model's.
    try:
        kind = "success" if meta.get("success_trained") else "cost"
        result["top_features"] = feature_importances(kind, db_path)[:5]
    except (ModelNotTrained, ValueError):
        result["top_features"] = []
    return result


def detect_anomalies(db_path: Path | str = DEFAULT_DB_PATH, n_sigma: float = N_SIGMA) -> list[dict[str, Any]]:
    """Flag historical runs whose actual cost/latency deviates from prediction.

    For every usable run, compare the observed cost/latency against the trained
    regressor's prediction; flag it when the residual exceeds `n_sigma` times
    the training residual std (the residual-based heuristic). Requires a trained
    bundle. Returns one record per flagged run.
    """
    _require_xgboost()
    meta = _load_meta(db_path)
    encoders = meta["encoders"]
    anomaly_ref = meta.get("anomaly_ref", {})
    frame = build_feature_frame(db_path)
    if not frame:
        return []
    X = _encode_frame(frame, encoders)

    cost_model = _load_model("cost", xgb.XGBRegressor, db_path)
    latency_model = _load_model("latency", xgb.XGBRegressor, db_path)
    cost_pred = cost_model.predict(X) if cost_model is not None else None
    latency_pred = latency_model.predict(X) if latency_model is not None else None

    out: list[dict[str, Any]] = []
    for i, row in enumerate(frame):
        flags = []
        if cost_pred is not None:
            std = anomaly_ref.get("cost", {}).get("residual_std", 0.0)
            if flag_anomaly(row["cost"], float(cost_pred[i]), std, n_sigma):
                flags.append("cost")
        if latency_pred is not None:
            std = anomaly_ref.get("latency", {}).get("residual_std", 0.0)
            if flag_anomaly(row["latency"], float(latency_pred[i]), std, n_sigma):
                flags.append("latency")
        if flags:
            out.append({
                "index": i,
                "provider_name": row.get("provider_name"),
                "anomalous_in": flags,
                "actual_cost": row["cost"],
                "predicted_cost": float(cost_pred[i]) if cost_pred is not None else None,
                "actual_latency": row["latency"],
                "predicted_latency": float(latency_pred[i]) if latency_pred is not None else None,
            })
    return out
