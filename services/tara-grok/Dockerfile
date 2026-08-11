FROM python:3.12-slim
WORKDIR /app
RUN useradd --uid 10001 --create-home tara
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY tara_grok ./tara_grok
USER 10001:10001
EXPOSE 8092
CMD ["uvicorn", "tara_grok.app:app", "--host", "0.0.0.0", "--port", "8092"]
