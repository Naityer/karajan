# Imagen headless para exponer la API de KARAJAN (recomendador + biblioteca
# Inspiration) sin la app de escritorio. `app/main.py` no importa pywebview,
# así que basta con las dependencias del modo standalone/servidor.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir \
    "fastapi>=0.111,<1.0" \
    "uvicorn[standard]>=0.30,<1.0" \
    "pydantic>=2.7,<3.0" \
    "httpx>=0.27,<1.0" \
    "openpyxl>=3.1,<4.0" \
    "PyJWT[crypto]>=2.9,<3.0"

COPY app/ ./app/
COPY dashboard/ ./dashboard/
COPY pyproject.toml ./

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
