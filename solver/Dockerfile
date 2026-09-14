FROM python:3.13-slim

WORKDIR /app/solver

# Dependencies first so a code change does not reinstall OR-Tools.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# The solver reads the seat maps and carrier policies the web app owns; compose
# mounts web/config read-only at this path so there is one source of truth.
ENV SEATMAPS_PATH=/app/web/config/seatmaps.json
ENV CARRIERS_PATH=/app/web/config/carriers.json
ENV PYTHONUNBUFFERED=1

CMD ["python", "worker.py"]
