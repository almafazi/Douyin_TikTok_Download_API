# gunicorn.conf.py
from app.main import Host_IP, Host_Port

# Jumlah worker berdasarkan CPU
workers = 10

# Menggunakan Uvicorn worker
worker_class = "uvicorn.workers.UvicornWorker"

# Binding ke semua interface dengan port 8000
bind = f"{Host_IP}:{Host_Port}"

# Timeout dalam detik
timeout = 120

# Log level
loglevel = "info"

# Preload aplikasi untuk performa lebih baik
preload_app = True

# Pengaturan log
accesslog = "-"  # Output ke stdout
errorlog = "-"   # Output ke stderr

max_requests = 1000
max_requests_jitter = 100
keepalive = 5

# Jika ingin menyimpan log ke file, gunakan:
# accesslog = "/var/log/gunicorn/access.log"
# errorlog = "/var/log/gunicorn/error.log"