#!/usr/bin/env bash
set -euo pipefail
gcloud run deploy reports-service --source . --region us-central1 --allow-unauthenticated
