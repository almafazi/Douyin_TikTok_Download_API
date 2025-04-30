FROM python:3.11-slim

# Install FFmpeg and required packages
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Create temp directory
RUN mkdir -p /app/temp && chmod 777 /app/temp

# Expose port
EXPOSE 3029

# Start application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3029", "--reload", "--log-level", "debug"]