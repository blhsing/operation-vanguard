using OperationVanguard.Core;
using Raylib_cs;

namespace OperationVanguard.Game.Audio;

/// <summary>
/// Asset-free native audio bank. Every sample is synthesized deterministically
/// into PCM at startup, mirroring the web edition's no-binary-assets contract.
/// </summary>
public sealed class NativeAudio : IDisposable
{
    private readonly Dictionary<Cue, Sound> _sounds = [];
    private Music _music;
    private Music _ambience;
    private bool _musicReady;
    private bool _ambienceReady;
    private float _environmentLevel = .35f;
    private bool _disposed;

    public NativeAudio()
    {
        Raylib.InitAudioDevice();
        if (!Raylib.IsAudioDeviceReady()) return;

        Add(Cue.UiMove, Wave(.045, (time, random) =>
            Math.Sin(time * Math.PI * 2 * 720) * Math.Exp(-time * 50) * .22));
        Add(Cue.UiAccept, Wave(.085, (time, random) =>
            (Math.Sin(time * Math.PI * 2 * 520) + Math.Sin(time * Math.PI * 2 * 780) * .45) *
            Math.Exp(-time * 30) * .25));
        Add(Cue.Footstep, Wave(.13, (time, random) =>
            (random * .65 + Math.Sin(time * Math.PI * 2 * 95) * .35) * Math.Exp(-time * 30) * .38));
        Add(Cue.Jump, Wave(.11, (time, random) =>
            (random * .25 + Math.Sin(time * Math.PI * 2 * (100 + time * 420)) * .5) *
            Math.Exp(-time * 22) * .3));
        Add(Cue.Land, Wave(.18, (time, random) =>
            (random * .5 + Math.Sin(time * Math.PI * 2 * 62) * .7) * Math.Exp(-time * 20) * .55));
        Add(Cue.Rifle, Wave(.22, (time, random) =>
        {
            var crack = random * Math.Exp(-time * 75);
            var body = Math.Sin(time * Math.PI * 2 * (115 - time * 180)) * Math.Exp(-time * 16);
            return (crack * .9 + body * .65) * .66;
        }));
        Add(Cue.Hit, Wave(.075, (time, random) =>
            (Math.Sin(time * Math.PI * 2 * 1200) + random * .2) * Math.Exp(-time * 55) * .22));
        Add(Cue.Explosion, Wave(.8, (time, random) =>
            (random * .8 + Math.Sin(time * Math.PI * 2 * 48) * .65) * Math.Exp(-time * 5.2) * .75));

        var filteredNoise = 0d;
        _ambience = Raylib.LoadMusicStreamFromMemory(".wav", Wave(4, (time, random) =>
        {
            filteredNoise = filteredNoise * .987 + random * .013;
            var wind = filteredNoise * .8 + Math.Sin(time * Math.PI * .5) * .035;
            return wind;
        }, 22050));
        _ambienceReady = Raylib.IsMusicValid(_ambience);
        if (_ambienceReady)
        {
            _ambience.Looping = true;
            Raylib.PlayMusicStream(_ambience);
        }

        var roots = new[] { 55d, 65.406d, 48.999d, 58.27d };
        _music = Raylib.LoadMusicStreamFromMemory(".wav", Wave(8, (time, random) =>
        {
            var segment = Math.Min(3, (int)(time / 2));
            var within = time - segment * 2;
            var root = roots[segment];
            var swell = Math.Pow(Math.Sin(Math.PI * within / 2), 2) * .7 + .15;
            var bass = Math.Sin(time * Math.PI * 2 * root) * .18;
            var fifth = Math.Sin(time * Math.PI * 2 * root * 1.5) * .08;
            var pulse = Math.Sin(time * Math.PI * 4) > .82
                ? Math.Sin(time * Math.PI * 2 * root * 4) * .035
                : 0;
            return (bass + fifth) * swell + pulse;
        }, 22050));
        _musicReady = Raylib.IsMusicValid(_music);
        if (_musicReady)
        {
            _music.Looping = true;
            Raylib.PlayMusicStream(_music);
        }
    }

    public float MasterVolume { get; set; } = .8f;
    public float SfxVolume { get; set; } = 1f;
    public float MusicVolume { get; set; } = .5f;

    public void Play(Cue cue, float volume = 1f, float pitch = 1f, float pan = .5f)
    {
        if (!_sounds.TryGetValue(cue, out var sound)) return;
        Raylib.SetSoundVolume(sound, Math.Clamp(volume * MasterVolume * SfxVolume, 0, 1));
        Raylib.SetSoundPitch(sound, Math.Clamp(pitch, .25f, 4));
        Raylib.SetSoundPan(sound, Math.Clamp(pan, 0, 1));
        Raylib.PlaySound(sound);
    }

    public void PlayWeapon(WeaponDef weapon, float volume = 1f, float pan = .5f)
    {
        var audio = weapon.Audio;
        var pitch = (float)Math.Clamp(Math.Sqrt(Math.Max(32d, audio.BodyFreq) / 168d), .62d, 1.55d);
        var body = (float)Math.Clamp(.5d + audio.Boom * .45d + audio.Mech * .08d, .35d, 1.25d);
        if (audio.Suppressed) body *= .48f;
        Play(Cue.Rifle, volume * body, pitch, pan);
    }

    public void PlayFootstep(SurfaceType surface, bool loud, float volume = 1f, float pan = .5f)
    {
        var pitch = surface switch
        {
            SurfaceType.Metal => 1.28f,
            SurfaceType.Wood => 1.08f,
            SurfaceType.Gravel => .9f,
            SurfaceType.Grass or SurfaceType.Dirt or SurfaceType.Sand => .78f,
            SurfaceType.Water => .68f,
            _ => .96f,
        };
        Play(Cue.Footstep, volume * (loud ? 1f : .72f), pitch, pan);
    }

    public void SetEnvironment(MapAmbience ambience)
    {
        _environmentLevel = (float)Math.Clamp(.14 + ambience.Wind * .55 + ambience.ReverbMix * .12, .08, .8);
    }

    public void Update()
    {
        if (_musicReady)
        {
            Raylib.UpdateMusicStream(_music);
            Raylib.SetMusicVolume(_music, Math.Clamp(MasterVolume * MusicVolume * .35f, 0, 1));
        }
        if (_ambienceReady)
        {
            Raylib.UpdateMusicStream(_ambience);
            Raylib.SetMusicVolume(_ambience, Math.Clamp(MasterVolume * SfxVolume * _environmentLevel, 0, 1));
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        foreach (var sound in _sounds.Values) Raylib.UnloadSound(sound);
        _sounds.Clear();
        if (_musicReady)
        {
            Raylib.StopMusicStream(_music);
            Raylib.UnloadMusicStream(_music);
        }
        if (_ambienceReady)
        {
            Raylib.StopMusicStream(_ambience);
            Raylib.UnloadMusicStream(_ambience);
        }
        if (Raylib.IsAudioDeviceReady()) Raylib.CloseAudioDevice();
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private void Add(Cue cue, byte[] pcmWave)
    {
        var wave = Raylib.LoadWaveFromMemory(".wav", pcmWave);
        if (!Raylib.IsWaveValid(wave)) return;
        var sound = Raylib.LoadSoundFromWave(wave);
        Raylib.UnloadWave(wave);
        if (Raylib.IsSoundValid(sound)) _sounds[cue] = sound;
    }

    private static byte[] Wave(double duration, Func<double, double, double> sample, int sampleRate = 44100)
    {
        const int channels = 1;
        const int bits = 16;
        var samples = (int)Math.Ceiling(duration * sampleRate);
        var dataBytes = samples * channels * (bits / 8);
        using var stream = new MemoryStream(44 + dataBytes);
        using var writer = new BinaryWriter(stream);
        writer.Write("RIFF"u8);
        writer.Write(36 + dataBytes);
        writer.Write("WAVE"u8);
        writer.Write("fmt "u8);
        writer.Write(16);
        writer.Write((short)1);
        writer.Write((short)channels);
        writer.Write(sampleRate);
        writer.Write(sampleRate * channels * bits / 8);
        writer.Write((short)(channels * bits / 8));
        writer.Write((short)bits);
        writer.Write("data"u8);
        writer.Write(dataBytes);

        uint state = 0x9e3779b9;
        for (var index = 0; index < samples; index++)
        {
            state = unchecked(state * 1664525u + 1013904223u);
            var random = state / 4294967296d * 2d - 1d;
            var value = Math.Clamp(sample(index / (double)sampleRate, random), -1d, 1d);
            writer.Write((short)Math.Round(value * short.MaxValue));
        }
        return stream.ToArray();
    }
}

public enum Cue
{
    UiMove,
    UiAccept,
    Footstep,
    Jump,
    Land,
    Rifle,
    Hit,
    Explosion,
}
