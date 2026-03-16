docker_repo := "bambam955/coil-team2"
docker_tag := "backend"

# List available recipes
default:
    @just --list --unsorted


# Build the project
build: build-backend

# Build the backend Docker container
build-backend:
    docker build -t {{docker_repo}}:{{docker_tag}} -f backend/Dockerfile backend/


# Deploy the project
deploy: push-backend

# Push the backend container to Docker Hub
push-backend: build-backend
    docker push {{docker_repo}}:{{docker_tag}}


# Run a dev server of the project (backend only for now)
dev:
    docker run --rm -it -p 8080:8080 {{docker_repo}}:{{docker_tag}}

# Install dependencies
deps:
    (cd backend && npm install --no-fund)
