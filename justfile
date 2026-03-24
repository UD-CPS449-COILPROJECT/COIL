docker_repo := "bambam955/coil-team2"

# List available recipes
default:
    @just --list --unsorted


# Run the default (production-like) environment via Docker Compose
run-prod:
    docker compose up --build

# Run a development environment with frontend file-mount hot updates
# Frontend serves local files from the working tree while both services run.
run-dev:
    docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# Bring down the development environment
down-dev:
    docker compose -f docker-compose.yml -f docker-compose.dev.yml down


# Build the project (target = all|frontend|backend)
build target="all": deps
    #!/usr/bin/env bash
    case "{{target}}" in
        "frontend"|"backend")
            docker build -t {{docker_repo}}:{{target}} -f {{target}}/Dockerfile {{target}}/
            ;;
        "all")
            docker build -t {{docker_repo}}:frontend -f frontend/Dockerfile frontend/
            docker build -t {{docker_repo}}:backend -f backend/Dockerfile backend/
            ;;
        *)
            echo "Invalid target: {{target}}. Use 'frontend', 'backend', or 'all'."
            exit 1
            ;;
    esac


# Deploy the project
deploy target="all":
    #!/usr/bin/env bash
    just build "{{target}}"
    case "{{target}}" in
        "frontend"|"backend")
            docker push {{docker_repo}}:{{target}}
            ;;
        "all")
            docker push {{docker_repo}}:frontend
            docker push {{docker_repo}}:backend
            ;;
        *)
            echo "Invalid target: {{target}}. Use 'frontend', 'backend', or 'all'."
            exit 1
            ;;
    esac


# Install dependencies
deps:
    (cd backend && npm install --no-fund)
