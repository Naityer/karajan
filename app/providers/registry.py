info = catalog.get_provider(name)
status = statuses.get(name)  # or statuses.get(info.name)
if not info or tier not in info.tiers or not (status and status.ready):
    continue
model_id = info.tiers.get(tier) or next(iter(info.tiers.values()), tier.val[8D[K
tier.value)
if info.backend == Backend.API:
    candidates.append(Resolution(ApiModelProvider(info), Backend.API, model[5D[K
model_id, info.name))
elif info.backend == Backend.CLI:
    candidates.append(Resolution(CliModelProvider(info), Backend.CLI, model[5D[K
model_id, info.name))