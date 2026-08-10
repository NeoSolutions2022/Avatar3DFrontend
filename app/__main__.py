import uvicorn

from .config import settings


uvicorn.run(
    "app.main:app",
    host=settings.host,
    port=settings.port,
    log_level=settings.log_level,
)
