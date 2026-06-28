# HIVEMIND repo tasks. `make help` lists targets.
.DEFAULT_GOAL := help

.PHONY: help publish-byod check-byod

help: ## List targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

publish-byod: ## Republish byod/ to the `byod` self-host setup branch (idempotent)
	@scripts/publish-byod.sh

check-byod: ## Fail if the `byod` setup branch has drifted from byod/
	@scripts/check-byod-sync.sh
