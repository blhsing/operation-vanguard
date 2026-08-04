using System.Text.Json;
using System.Text.Json.Serialization;

namespace OperationVanguard.Core;

internal static class RegistryJson
{
    private static readonly JsonSerializerOptions Options = CreateOptions();

    internal static List<T> DeserializeList<T>(string json)
        => JsonSerializer.Deserialize<List<T>>(json, Options)
           ?? throw new InvalidOperationException($"Could not deserialize {typeof(T).Name} registry.");

    private static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        };
        options.Converters.Add(new ExactDoubleConverter());
        return options;
    }

    private sealed class ExactDoubleConverter : JsonConverter<double>
    {
        public override double Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            if (reader.TokenType == JsonTokenType.Number) return reader.GetDouble();
            if (reader.TokenType != JsonTokenType.String)
                throw new JsonException($"Expected a number, got {reader.TokenType}.");

            return reader.GetString() switch
            {
                "__OV_INFINITY__" => double.PositiveInfinity,
                "__OV_NEG_INFINITY__" => double.NegativeInfinity,
                "__OV_NAN__" => double.NaN,
                var value when double.TryParse(value, System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out var parsed) => parsed,
                var value => throw new JsonException($"Invalid floating-point literal '{value}'."),
            };
        }

        public override void Write(Utf8JsonWriter writer, double value, JsonSerializerOptions options)
        {
            if (double.IsPositiveInfinity(value)) writer.WriteStringValue("__OV_INFINITY__");
            else if (double.IsNegativeInfinity(value)) writer.WriteStringValue("__OV_NEG_INFINITY__");
            else if (double.IsNaN(value)) writer.WriteStringValue("__OV_NAN__");
            else writer.WriteNumberValue(value);
        }
    }
}

internal static class DataNumber
{
    // All callers use positive values. This is Math.round rather than banker's rounding.
    internal static int JsRoundToInt(double value) => checked((int)Math.Floor(value + 0.5));
    internal static int JsTruncateToInt(double value) => unchecked((int)value);
}
