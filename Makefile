# Common tasks. Run `make install` once, then the rest.
PY := .venv/bin/python

.PHONY: install serve static findings report test e2e lint check eval docker

install:            ## create .venv and install the package with dev tools
	python3 -m venv .venv && $(PY) -m pip install -e ".[dev]"

serve:              ## app + shared journal + AI agents on http://localhost:8002
	.venv/bin/workpaper serve --port 8002

static:             ## the static app alone on http://localhost:8001 (journal in the browser)
	$(PY) -m http.server 8001 --bind 127.0.0.1 -d web

findings:           ## rebuild web/data/findings.json after changing a check
	.venv/bin/workpaper build-findings

report:             ## the 20 issues, checked against docs/ERRORS_FOUND.md
	.venv/bin/workpaper report --check

test:               ## unit and integration tests (no browser, no API calls)
	$(PY) -m pytest

e2e:                ## real-browser tests in Chrome, static and server modes
	$(PY) -m pytest -m e2e

lint:
	.venv/bin/ruff check src tests

check: lint test report   ## what CI runs

eval:               ## score the AI preparer blind (spends API credit)
	.venv/bin/workpaper eval --yes

docker:             ## build the server image
	docker build -t workpaper .
