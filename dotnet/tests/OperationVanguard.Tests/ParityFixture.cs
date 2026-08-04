using System.Text.Json;

namespace OperationVanguard.Tests;

internal static class ParityFixture
{
    private static readonly Lazy<JsonDocument> ContentDocument = new(() => Load("content.json"));
    private static readonly Lazy<JsonDocument> RngDocument = new(() => Load("rng.json"));
    private static readonly Lazy<JsonDocument> ProtocolDocument = new(() => Load("protocol.json"));

    internal static JsonElement Content => ContentDocument.Value.RootElement;
    internal static JsonElement Rng => RngDocument.Value.RootElement;
    internal static JsonElement Protocol => ProtocolDocument.Value.RootElement;

    private static JsonDocument Load(string name)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "parity", name);
        return JsonDocument.Parse(File.ReadAllBytes(path));
    }
}
