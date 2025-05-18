#!/bin/sh

# Starting the Python application directly using python3
gunicorn app.main:app -c gunicorn.conf.py