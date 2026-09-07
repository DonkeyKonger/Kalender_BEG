FROM node:22-bookworm-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# Never use the developer's or cloud's Vite configuration/secrets.
ENV VITE_API_BASE_URL=/api
RUN npm run build

FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app/backend
COPY backend/ ./
RUN pip install --no-cache-dir . && useradd --uid 10001 --create-home tester
# COPY preserves restrictive host permissions (e.g. 0660 on downloaded XLSX).
# Templates must be readable by the unprivileged runtime user, too.
RUN chmod -R a+rX /app/backend/app/templates
COPY --from=frontend /frontend/dist /app/frontend
COPY tools/local_calendar/ /app/local_calendar/
ENV PYTHONPATH=/app/backend:/app/local_calendar
USER tester
# Fail the image build before startup if the real runtime user cannot load Excel.
RUN python -c "from app.services.payroll_xlsx_template import load_payroll_monthly_template; load_payroll_monthly_template()"
CMD ["python", "/app/local_calendar/runtime.py", "serve"]
