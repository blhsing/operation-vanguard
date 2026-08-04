using Xunit;

// The web simulation intentionally reuses process-static scratch objects and
// per-player runtime tables. Its C# parity port preserves that allocation model,
// so independent simulations must not be advanced concurrently in one process.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
