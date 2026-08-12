# Resource recommendation v2

## Objective

Given an agent prompt, retrieve the smallest useful set of catalog resources,
prefer a concrete nested child over its directory, and abstain when the core
capability is absent. Recommendation must never install, enable, or attach a
resource.

## Suites

- `tests/test_resource_recommendation_eval.py`: bilingual gold cases,
  paraphrases, typos, hard negatives, nested resources, FTS5 and SQL fallback.
- `tests/test_resource_recommendation_benchmark.py`: 10,000 resources, 20
  warmups and 200 measured queries.
- `tests/test_resource_api.py`: compatible response fields plus v2 decision,
  confidence, coverage, evidence, parent context and explicit reindexing.

## Release gates

- Critical Hit@1: 100%.
- Hit@3 >= 95%, MRR >= 0.90, nDCG@5 >= 0.90.
- Critical abstention precision: 100%; false primaries < 2%.
- Nested-child Recall@3 >= 95%.
- p95 <= 150 ms, p99 <= 250 ms, cold query <= 300 ms at 10k resources.
- Three consecutive deterministic runs produce identical ordering and roles.

The versioned prompts live in
`tests/fixtures/resource_retrieval_cases.json`; every corrected failure must be
added there or as a focused regression before changing weights or vocabulary.
