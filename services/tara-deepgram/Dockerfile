FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY tara_deepgram ./tara_deepgram
EXPOSE 8091
CMD ["uvicorn", "tara_deepgram.app:app", "--host", "0.0.0.0", "--port", "8091"]
