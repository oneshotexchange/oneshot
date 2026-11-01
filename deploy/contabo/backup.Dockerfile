FROM postgres:17-bookworm
# Use the same PostgreSQL major for pg_dump/pg_restore as the database.
RUN apt-get update \
    && apt-get install -y --no-install-recommends restic ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY backup.sh /usr/local/bin/oneshot-backup
RUN chmod 0755 /usr/local/bin/oneshot-backup
ENTRYPOINT ["/usr/local/bin/oneshot-backup"]
CMD ["backup"]
