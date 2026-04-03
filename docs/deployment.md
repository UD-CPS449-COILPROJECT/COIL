# Deployment

## Release Deployments

Docker image publishing is handled by GitHub Actions when a new Git tag is pushed to `origin`.
The workflow lives at `.github/workflows/docker-deploy.yml` and only runs for newly created tags,
so normal branch pushes do not publish release images.

Before using the workflow, configure these GitHub environment secrets in `Production`:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

Release flow:

1. Commit and merge the release-ready code.
2. Create a tag such as `1.0.0`.
3. Push the tag with `git push origin 1.0.0`.
4. GitHub Actions builds and pushes `bambam955/coil-team2:frontend`,
   `bambam955/coil-team2:backend`, and tag-specific images such as
   `bambam955/coil-team2:frontend-1.0.0` and `bambam955/coil-team2:backend-1.0.0`.
5. GitHub runs the workflow in the `Production` environment, so any required protection rules or
   approvals for that environment apply before the image push completes.

## Local Image Builds

The `just build` recipe remains available for local image builds:

- `just build`
- `just build frontend`
- `just build backend`

Those recipes are intended for local validation only. Release image publishing now happens through
the tag-triggered GitHub Actions workflow instead of a manual `just deploy` step.

## Azure Follow-Up

- This repository now automates image publishing, but it does not restart Azure for you.
- After a release tag is published, restart or redeploy the Azure workload so it pulls the updated
  `frontend` and `backend` images, unless the Azure service is already configured to refresh images
  automatically.
