# OpsBoard Enterprise

OpsBoard Enterprise is a production-style DevOps and IT Operations platform built with Node.js, MongoDB, Redis, Docker Compose, and Nginx.

## Features

- User Authentication with JWT
- Role-based access: Admin / Engineer
- Project Management
- Task Management
- Incident Management
- Deployment Tracking
- Audit Logs
- Health Check Endpoint
- Metrics Endpoint
- Redis Caching
- MongoDB Persistence
- Nginx Reverse Proxy
- Dockerized Multi-Service Architecture

## Tech Stack

- Node.js
- Express.js
- MongoDB
- Redis
- Docker
- Docker Compose
- Nginx
- JWT
- GitHub Actions

## Architecture

User Browser  
→ Nginx Reverse Proxy  
→ Node.js Backend  
→ MongoDB Database  
→ Redis Cache

## Run Locally

```bash
docker compose up -d --build
