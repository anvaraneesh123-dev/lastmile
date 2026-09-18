# Build and run LastMile Guardian Java 21 Backend
FROM eclipse-temurin:21-jdk-alpine AS builder
WORKDIR /app
COPY LastMileServer.java .
RUN javac LastMileServer.java

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=builder /app/*.class .
COPY index.html app.js manifest.json .
EXPOSE 8080
ENV PORT=8080
CMD ["java", "LastMileServer"]
