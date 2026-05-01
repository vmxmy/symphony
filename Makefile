.PHONY: setup typecheck test build all

TS_ENGINE_DIR := ts-engine
BUN := bun

setup:
	cd $(TS_ENGINE_DIR) && $(BUN) install --frozen-lockfile

typecheck:
	cd $(TS_ENGINE_DIR) && $(BUN) run typecheck

test:
	cd $(TS_ENGINE_DIR) && $(BUN) test

build:
	cd $(TS_ENGINE_DIR) && $(BUN) run build

all: setup typecheck test build
