FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY workers/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
  && useradd --system --uid 10001 worker \
  && mkdir -p /data \
  && chown worker:worker /data

COPY workers/mtproto_worker.py workers/range_math.py workers/chunk_cache.py ./workers/
USER worker

EXPOSE 8000
CMD ["sh", "-c", "uvicorn mtproto_worker:app --app-dir /app/workers --host 0.0.0.0 --port ${PORT:-8000}"]
