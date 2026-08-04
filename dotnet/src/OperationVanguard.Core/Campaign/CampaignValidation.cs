using System.Globalization;

namespace OperationVanguard.Core;

public interface IMissionGeometryProbe
{
    double GroundNear(double x, double z, double from, double depth);

    bool Standable(double x, double y, double z);
}

public static class CampaignValidation
{
    public static IReadOnlyList<string> ValidateMission(MissionDef mission)
    {
        var errors = new List<string>();
        var tag = mission.Id;

        if (mission.Objectives.Count == 0)
        {
            errors.Add($"{tag}: has no objectives");
            return errors;
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var objective in mission.Objectives)
        {
            if (!ids.Add(objective.Id))
            {
                errors.Add($"{tag}: duplicate objective id '{objective.Id}'");
            }
        }

        foreach (var objective in mission.Objectives)
        {
            foreach (var dependency in objective.After ?? [])
            {
                if (!ids.Contains(dependency))
                {
                    errors.Add($"{tag}: objective '{objective.Id}' waits on '{dependency}', which does not exist");
                }

                if (dependency == objective.Id)
                {
                    errors.Add($"{tag}: objective '{objective.Id}' waits on itself");
                }
            }
        }

        if (!mission.Objectives.Any(objective => (objective.After?.Count ?? 0) == 0))
        {
            errors.Add($"{tag}: every objective waits on another, so none can start");
        }

        var done = new HashSet<string>(StringComparer.Ordinal);
        for (var pass = 0; pass < mission.Objectives.Count + 1; pass++)
        {
            foreach (var objective in mission.Objectives)
            {
                if (done.Contains(objective.Id))
                {
                    continue;
                }

                if ((objective.After ?? []).All(done.Contains))
                {
                    done.Add(objective.Id);
                }
            }
        }

        foreach (var objective in mission.Objectives)
        {
            if (!done.Contains(objective.Id))
            {
                errors.Add($"{tag}: objective '{objective.Id}' is unreachable — check for a dependency cycle");
            }
        }

        var allyIds = mission.Allies.Select(ally => ally.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var objective in mission.Objectives)
        {
            if (objective.Trigger is EscortTrigger escort && !allyIds.Contains(escort.Ally))
            {
                errors.Add($"{tag}: objective '{objective.Id}' escorts '{escort.Ally}', who is not in the squad");
            }

            var endless = (objective.Waves ?? []).Any(wave => wave.Endless);
            if (endless && objective.Trigger is ClearTrigger or EliminateTrigger)
            {
                errors.Add(
                    $"{tag}: objective '{objective.Id}' spawns an endless wave but completes by killing — " +
                    "it can never be finished");
            }

            foreach (var wave in objective.Waves ?? [])
            {
                if (wave.Count <= 0)
                {
                    errors.Add($"{tag}: objective '{objective.Id}' has a wave of {wave.Count}");
                }

                if (wave.Interval < 0)
                {
                    errors.Add($"{tag}: objective '{objective.Id}' has a negative wave interval");
                }
            }

            if (objective.Trigger is SurviveTrigger survive && survive.Seconds <= 0)
            {
                errors.Add($"{tag}: objective '{objective.Id}' survives for {Number(survive.Seconds)} seconds");
            }

            if (objective.Trigger is EliminateTrigger eliminate)
            {
                var fromHere = (objective.Waves ?? []).Sum(wave => wave.Count);
                var fromGarrison = (mission.Garrison ?? []).Sum(wave => wave.Count);
                var fromEarlier = mission.Objectives
                    .Where(other => other.Id != objective.Id)
                    .Sum(other => (other.Waves ?? []).Sum(wave => wave.Count));
                var available = fromHere + fromGarrison + fromEarlier;

                if (eliminate.Count > available)
                {
                    errors.Add(
                        $"{tag}: objective '{objective.Id}' needs {eliminate.Count} kills but the mission " +
                        $"only ever spawns {available} hostiles");
                }

                if (eliminate.Count > fromHere + fromGarrison)
                {
                    errors.Add(
                        $"{tag}: objective '{objective.Id}' needs {eliminate.Count} kills but its own waves " +
                        $"and the garrison only supply {fromHere + fromGarrison}");
                }
            }
        }

        if (mission.Objectives.Count > 2 && !mission.Objectives.Any(objective => objective.Checkpoint))
        {
            errors.Add($"{tag}: no objective sets a checkpoint, so every death replays the whole mission");
        }

        return errors;
    }

    public static IReadOnlyList<string> ValidateMissionGeometry(
        MissionDef mission,
        IMissionGeometryProbe probe)
    {
        const double lookUp = 2;
        const double lookDown = 6;
        var errors = new List<string>();
        var tag = mission.Id;

        void Check(string what, Vec3 point)
        {
            var ground = probe.GroundNear(point.X, point.Z, point.Y + lookUp, lookDown);
            if (!double.IsFinite(ground))
            {
                errors.Add(
                    $"{tag}: {what} at ({Number(point.X)}, {Number(point.Y)}, {Number(point.Z)}) has no floor within " +
                    $"{Number(lookDown - lookUp)}m below it — it is probably on the wrong storey");
                return;
            }

            if (!probe.Standable(point.X, ground + 0.05, point.Z))
            {
                errors.Add($"{tag}: {what} at ({Number(point.X)}, {Number(point.Z)}) is inside geometry");
            }
        }

        Check("insertion", mission.Insertion.Position);
        foreach (var ally in mission.Allies)
        {
            Check($"ally '{ally.Id}'", ally.Spawn);
        }

        foreach (var wave in mission.Garrison ?? [])
        {
            Check("garrison spawn", wave.Spawn);
            if (wave.Post is not null)
            {
                Check("garrison post", wave.Post);
            }
        }

        foreach (var objective in mission.Objectives)
        {
            foreach (var wave in objective.Waves ?? [])
            {
                Check($"objective '{objective.Id}' wave spawn", wave.Spawn);
                if (wave.Post is not null)
                {
                    Check($"objective '{objective.Id}' wave post", wave.Post);
                }
            }
        }

        return errors;
    }

    private static string Number(double value) => value.ToString("G", CultureInfo.InvariantCulture);
}
