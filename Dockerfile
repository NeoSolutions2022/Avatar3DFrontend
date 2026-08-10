FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AVATAR3D_HOST=0.0.0.0 \
    AVATAR3D_PORT=8080 \
    AVATAR3D_DATA_DIR=/data \
    AVATAR3D_FRONTEND_DIR=/app/frontend \
    AVATAR3D_WEBGL_DIR=/app/webgl

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --requirement requirements.txt

COPY app ./app
COPY frontend ./frontend
COPY webgl ./webgl

RUN addgroup --system avatar3d \
    && adduser --system --ingroup avatar3d avatar3d \
    && mkdir -p /data \
    && chown -R avatar3d:avatar3d /data /app

USER avatar3d
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/v1/health', timeout=3)"

CMD ["python", "-m", "app"]
