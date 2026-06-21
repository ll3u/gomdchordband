FROM golang:1.26-alpine AS builder

WORKDIR /app

# Mod-Dateien kopieren und Abhängigkeiten laden
COPY go.mod go.sum ./
RUN go mod download

# Quellcode kopieren
COPY . .

ARG VERSION=dev
# Statische Linux-Binary kompilieren
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o gomdchordband main.go
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags "-X main.Version=${VERSION}" -o gomdchordband .

# Stage 2: Minimales, sicheres Runtime-Image
FROM alpine:3.20

WORKDIR /app

# Erstellt die benötigten Verzeichnisse im Container vor
RUN mkdir -p /app/songs/backup

# Kopiert nur die schlanke Binary aus dem Builder
COPY --from=builder /app/gomdchordband .

# Exponiert den Port für den Server
EXPOSE 8080

CMD ["./gomdchordband"]