# Deployment follow-up checklist (Step 11c)

Full command reference for `flow-pr-review/SKILL.md` Step 11c's "Deployment
Follow-Up Check" — copy-pasteable commands (with `<PLACEHOLDER>` values
matching `DEPLOYING.md` conventions) for each category of manual
outside-the-codebase follow-up.

- **New environment variables** (`.env.example` additions):
  - Local: `<VAR>=<value>` in `.env`
  - Production: create secret + grant access + redeploy. Read the secret via `read -s`
    (keeps it out of shell history) and bind a dedicated runtime service account rather
    than the default Compute SA (which is shared and Editor-by-default):
    ```bash
    read -s SECRET_VALUE && printf '%s' "$SECRET_VALUE" \
      | gcloud secrets create <VAR> --data-file=-
    unset SECRET_VALUE
    gcloud secrets add-iam-policy-binding <VAR> \
      --member="serviceAccount:<SERVICE_NAME>-runtime@<PROJECT_ID>.iam.gserviceaccount.com" \
      --role="roles/secretmanager.secretAccessor"
    gcloud run deploy <SERVICE_NAME> --region us-central1 \
      --image <ARTIFACT_REGISTRY_PATH>/proxy:latest \
      --service-account="<SERVICE_NAME>-runtime@<PROJECT_ID>.iam.gserviceaccount.com" \
      --set-secrets "...,<VAR>=<VAR>:latest"
    ```
    Create the runtime SA once with `gcloud iam service-accounts create <SERVICE_NAME>-runtime`
    if it doesn't already exist.
- **New frontend build vars** (`VITE_*`): Set in Cloudflare Pages dashboard → Settings →
  Environment variables (both Production and Preview).
- **New allowlist files**: Verify `backend/Dockerfile` COPYs them into the image.
- **Database migrations**: `supabase db push` against the linked remote project.

If any follow-up items are found, include a **Deployment follow-up** section in the PR
description (Step 11e) listing each action with the exact commands. This prevents "works
locally, breaks in prod" gaps.
