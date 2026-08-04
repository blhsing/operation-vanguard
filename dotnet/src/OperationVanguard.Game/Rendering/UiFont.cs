using System.Numerics;
using System.Text;
using OperationVanguard.Core;
using Raylib_cs;

namespace OperationVanguard.Game.Rendering;

/// <summary>Loads a system CJK font while keeping the repository asset-free.</summary>
public sealed class UiFont : IDisposable
{
    private const float TextScale = 1.7f;
    private const int AtlasFontSize = 128;
    private readonly bool _owned;
    private bool _disposed;

    public UiFont()
    {
        var path = FindFont();
        if (path is not null)
        {
            var codepoints = BuildCodepoints();
            var font = Raylib.LoadFontEx(path, AtlasFontSize, codepoints, codepoints.Length);
            if (Raylib.IsFontValid(font))
            {
                Raylib.SetTextureFilter(font.Texture, TextureFilter.Bilinear);
                Value = font;
                _owned = true;
                return;
            }
        }

        Value = Raylib.GetFontDefault();
    }

    public Font Value { get; }

    public void Draw(string text, float x, float y, float size, Color color, float spacing = 0.5f)
    {
        size *= TextScale;
        DrawWeighted(text, new Vector2(x, y), size, spacing, color);
    }

    public void DrawOutlined(
        string text,
        float x,
        float y,
        float size,
        Color color,
        float spacing = 0.5f,
        float outlineThickness = 0f)
    {
        size *= TextScale;
        var position = new Vector2(x, y);
        var thickness = outlineThickness > 0
            ? outlineThickness
            : Math.Clamp(size / 15f, 1.5f, 3.5f);
        var outline = new Color(0, 0, 0, 245);
        foreach (var offset in OutlineOffsets)
            Raylib.DrawTextEx(Value, text, position + offset * thickness, size, spacing, outline);
        DrawWeighted(text, position, size, spacing, color);
    }

    public Vector2 Measure(string text, float size, float spacing = 0.5f) =>
        Raylib.MeasureTextEx(Value, text, size * TextScale, spacing);

    public void DrawCentered(string text, float y, float size, Color color)
    {
        var width = Measure(text, size).X;
        Draw(text, (Raylib.GetScreenWidth() - width) / 2f, y, size, color);
    }

    public void DrawCenteredOutlined(string text, float y, float size, Color color)
    {
        var width = Measure(text, size).X;
        DrawOutlined(text, (Raylib.GetScreenWidth() - width) / 2f, y, size, color);
    }

    public void Dispose()
    {
        if (_disposed) return;
        if (_owned) Raylib.UnloadFont(Value);
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private static int[] BuildCodepoints()
    {
        var text = new StringBuilder(
            "先鋒行動戰術射擊遊戲開始任務戰役選擇返回設定操作退出暫停繼續重新出發快速存檔讀取尚無相容" +
            "生命彈藥目標完成失敗消滅抵達守住互動護送盟軍敵軍裝填衝刺趴下蹲下" +
            "任務完成從檢查點重新部署下一章關鍵陣亡超過時限中止時間返回戰役選擇✓◇" +
            "零一二三四五六七八九年月日時分秒第章按鍵滑鼠左鍵右鍵空白鍵擊殺死亡得分" +
            "快速對戰配裝兵種主武器副武器配件槍口槍管瞄具下掛彈匣槍托後握把雷射" +
            "致命裝備戰術裝備戰地升級特技連殺獎勵軍階鎖定項目解鎖儲存開關音量" +
            "連線對戰伺服器位址正在等待回應取消逾時協定版本快照校正中斷同步支援安全即時平手呼號控制器死區輔助切換式" +
            "按鍵配置每個動作可設定主要與備用前進後退向左向右開火購買切換武器傾身恢復預設重新綁定欄位捕捉輸入按鈕移除其他" +
            "視野靈敏度反轉垂直自動介面比例效果音樂地圖模式電腦兵難度計分板玩家" +
            // Every CJK glyph used by native source literals. Registry and campaign text is appended below.
            "一七三下並中主九二互五亡交人介代以件任位住佔作使來例保個停備傳像儲先入全八六兵具再出分別利制刺副助動務勝勵化匣十升即反口可右合命器四回固圖地垂型場填境多失套始字存守安完定家射專對小左已幀年度延式彈影役後得從心快性成戰戲所手托技把抵拆按掛控換握擇擊操擬攻效敏敗整敵數料新日明星時暫更最會月有未束板果查核槍樂標模機檢欄止正步武死殊殺比決消涯準滅滑火炸無特狙獎獨率玩環生用發白盟目直瞄確示秒移程種空突立章第管精級結給繼續置署翻老腦自致與落藥號行術衝裝規視角解計設認說調護變資賽超越趴跳蹲躍軍軸輕輸轉近返退送速連遊過達選部配重野量鋒鍵鎖鏟鐘長開間關限陣除階隨難零雷電霰靈面音項預領顯點鼠" +
            "一七三上下不並中主九二互五亡交人介代以件任位住佔作使來例保個倒停備傳像儲先入全八六兵具再出分別利制刺副力助動務勝勵化匣區十升即去友反取口可右合命啟器四回固圖地垂型域場填境增多失套始字存守安完定家射專對小就屍左已幀年度延式強彈影役後得從心快性成戰戲所手托技把抵拆按掛控換握援擇擊擋操擬攻效敏救敗整敵數料新斷日明星時暫更最會月有未束板果查核槍樂標模機檢欄歇止正步武死殊殭殺比決活流消涯清準滅滑潮火炸無牆特狙獎獨率玩環瓦生用發白的盟目直瞄確礫示神秒秘移程種空突立章第管箱精級結給繼續置署翻老腦自致與落藥號血行術衝裝規視角解計設認說調護變販資賣賺賽起超越趴跳蹲躍軍軸輕輸轉近返退送速連進遊過達選部配重野量鋒鍵鎖鏟鐘長開間關限陣除隊階隨難零雷電霰靈面音項預領顯高點鼠" +
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" +
            " .,:;!?+-/()[]%°·—…「」『』，。！？：；（）、‹›▲▼↑↓←→");

        foreach (var mission in CampaignCatalog.CampaignMissions)
        {
            text.Append(mission.Name).Append(mission.Brief).Append(mission.Outro);
            foreach (var objective in mission.Objectives)
                text.Append(objective.Label).Append(objective.Line);
            foreach (var ally in mission.Allies) text.Append(ally.Name);
        }
        foreach (var map in Maps.All)
            text.Append(map.Name).Append(map.Tagline).Append(map.Description);
        foreach (var weapon in WeaponData.All)
            text.Append(weapon.Name).Append(weapon.ShortName).Append(weapon.Description);
        foreach (var attachment in AttachmentData.All)
        {
            text.Append(attachment.Name).Append(attachment.Description);
            foreach (var value in attachment.Pros) text.Append(value);
            foreach (var value in attachment.Cons) text.Append(value);
        }
        foreach (var perk in PerkData.All) text.Append(perk.Name).Append(perk.Description);
        foreach (var equipment in EquipmentData.All) text.Append(equipment.Name).Append(equipment.Description);
        foreach (var streak in KillstreakData.All)
            text.Append(streak.Name).Append(streak.Description).Append(streak.FriendlyAnnounce).Append(streak.EnemyAnnounce);
        foreach (var mode in ModeData.All)
            text.Append(mode.Name).Append(mode.ShortName).Append(mode.Description).Append(mode.IntroLine);
        foreach (var difficulty in BotData.Difficulties.Values) text.Append(difficulty.Name);
        foreach (var zombieMap in ZombieMaps.All.Values)
        {
            foreach (var zone in zombieMap.Zones) text.Append(zone.Name);
            foreach (var interactable in zombieMap.Interactables) text.Append(interactable.Label);
        }
        foreach (var perk in ZombieData.Perks.Values) text.Append(perk.Name).Append(perk.Description);

        return text.ToString().EnumerateRunes()
            .Select(rune => rune.Value)
            .Distinct()
            .Order()
            .ToArray();
    }

    private static string? FindFont()
    {
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var candidates = new[]
        {
            string.IsNullOrWhiteSpace(windows) ? null : Path.Combine(windows, "Fonts", "NotoSansTC-VF.ttf"),
            string.IsNullOrWhiteSpace(windows) ? null : Path.Combine(windows, "Fonts", "NotoSansHK-VF.ttf"),
            string.IsNullOrWhiteSpace(windows) ? null : Path.Combine(windows, "Fonts", "msjhbd.ttc"),
            string.IsNullOrWhiteSpace(windows) ? null : Path.Combine(windows, "Fonts", "msjh.ttc"),
            "/System/Library/Fonts/PingFang.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        };
        return candidates.FirstOrDefault(path => path is not null && File.Exists(path));
    }

    private void DrawWeighted(string text, Vector2 position, float size, float spacing, Color color)
    {
        Raylib.DrawTextEx(Value, text, position, size, spacing, color);

        // Menu subtitles and HUD metadata are intentionally compact. Give those
        // sizes a symmetric synthetic medium weight so they remain readable on
        // high-DPI displays without returning to a low-resolution font atlas.
        if (size <= 31f)
        {
            var subtitleWeight = Math.Clamp(size / 38f, .62f, .92f);
            Raylib.DrawTextEx(Value, text, position + new Vector2(-subtitleWeight, 0), size, spacing, color);
            Raylib.DrawTextEx(Value, text, position + new Vector2(subtitleWeight, 0), size, spacing, color);
            Raylib.DrawTextEx(Value, text, position + new Vector2(0, subtitleWeight * .65f), size, spacing, color);
            return;
        }

        var weight = Math.Clamp(size / 96f, .3f, .9f);
        Raylib.DrawTextEx(Value, text, position + new Vector2(weight, 0), size, spacing, color);
    }

    private static readonly Vector2[] OutlineOffsets =
    [
        new(-1, -1), new(0, -1), new(1, -1),
        new(-1, 0),               new(1, 0),
        new(-1, 1),  new(0, 1),  new(1, 1),
    ];
}
