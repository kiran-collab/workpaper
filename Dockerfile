# The server: app, shared journal and AI agents. Pass ANTHROPIC_API_KEY at run time to enable the agents.
#   docker build -t workpaper .
#   docker run -p 8002:8002 -v workpaper-data:/app/var --env-file .env workpaper   (or: make docker-run)
# The journal lives in the volume; without ANTHROPIC_API_KEY everything works except the AI agents.
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 WP_ROOT=/app

COPY pyproject.toml README.md ./
COPY src ./src
COPY web ./web
RUN pip install --no-cache-dir ".[agents]" \
 && useradd --create-home app && mkdir -p var && chown app var
USER app

EXPOSE 8002
VOLUME ["/app/var"]
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8002/api/health')"
CMD ["workpaper", "serve", "--host", "0.0.0.0", "--port", "8002"]
