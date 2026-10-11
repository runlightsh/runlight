package sh.runlight.db;

/**
 * Another process held the lock for creating tables past {@link JdbcDb#LOCK_WAIT_MS}, such as one
 * building an index on a big table after an upgrade. The request that waited fails with this,
 * rather than waiting for good.
 */
public final class TablesBusyError extends RuntimeException {
  private static final long serialVersionUID = 1L;

  public TablesBusyError() {
    this(JdbcDb.LOCK_WAIT_MS);
  }

  /**
   * @param waited how long the lock was waited for, in milliseconds
   */
  public TablesBusyError(long waited) {
    super(
        "Runlight: another process is creating or upgrading the tables, and had not finished after "
            + Math.round(waited / 1000.0)
            + " seconds. Try again in a minute.");
  }
}
