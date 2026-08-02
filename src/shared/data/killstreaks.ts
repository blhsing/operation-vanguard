/**
 * Killstreak table.
 *
 * `cost` is the classic consecutive-kill requirement; `scoreCost` is the same
 * reward on the scorestreak ladder, priced at roughly 500 points per kill so a
 * player who plays the objective earns streaks at a comparable rate to a player
 * who only shoots people.
 *
 * Announce lines are radio chatter, deliberately split by side: hearing "enemy
 * air support inbound" is the warning that makes a streak counterable, so the two
 * teams must never be told the same thing.
 */

import { KillstreakVehicleKind } from '../types.js';

export interface KillstreakDef {
  id: string;
  name: string;
  /** Consecutive kills required. */
  cost: number;
  /** Points required on the scorestreak ladder. */
  scoreCost: number;
  description: string;
  /**
   * How the sim spawns it:
   *  - `passive`     — applies to the owner only, no world entity
   *  - `call_in`     — AI-flown or scripted entity
   *  - `controlled`  — the player takes direct control
   *  - `care_package`— drops a crate someone has to physically claim
   *  - `deployable`  — a placed object with health that can be destroyed
   */
  kind: 'passive' | 'call_in' | 'controlled' | 'care_package' | 'deployable';
  /** Seconds the effect or entity lasts. 0 = instantaneous. */
  duration: number;
  vehicle?: KillstreakVehicleKind;
  damage?: number;
  radius?: number;
  health?: number;
  unlockLevel: number;
  friendlyAnnounce: string;
  enemyAnnounce: string;
}

export const KILLSTREAKS: Record<string, KillstreakDef> = {
  uav: {
    id: 'uav',
    name: '無人機',
    cost: 3,
    scoreCost: 1500,
    description: '在小地圖上標出敵人位置。',
    kind: 'call_in',
    duration: 30,
    vehicle: KillstreakVehicleKind.UAV,
    health: 250,
    unlockLevel: 0,
    friendlyAnnounce: '無人機已在上空——注意地圖。',
    enemyAnnounce: '敵方無人機升空。避開雷達。',
  },
  personal_radar: {
    id: 'personal_radar',
    name: '個人雷達',
    cost: 4,
    scoreCost: 2000,
    description: '只有你看得見的雷達掃描。沒有實體可供擊落。',
    kind: 'passive',
    duration: 60,
    radius: 45,
    unlockLevel: 2,
    friendlyAnnounce: '個人雷達已上線。',
    enemyAnnounce: '',
  },
  counter_uav: {
    id: 'counter_uav',
    name: '反制無人機',
    cost: 4,
    scoreCost: 2000,
    description: '干擾敵方小地圖，擾亂其雷達回波。',
    kind: 'call_in',
    duration: 30,
    vehicle: KillstreakVehicleKind.CounterUAV,
    health: 250,
    unlockLevel: 4,
    friendlyAnnounce: '反制無人機接近中——他們的雷達失效了。',
    enemyAnnounce: '雷達遭干擾！敵方反制無人機已升空。',
  },
  care_package: {
    id: 'care_package',
    name: '補給包',
    cost: 4,
    scoreCost: 2000,
    description: '標記投放區，空投隨機的連殺獎勵補給箱。任何人都能撿取。',
    kind: 'care_package',
    duration: 90,
    unlockLevel: 6,
    friendlyAnnounce: '補給包投放中——注意煙霧標記。',
    enemyAnnounce: '敵方補給包投放中。搶過來。',
  },
  cluster_strike: {
    id: 'cluster_strike',
    name: '集束打擊',
    cost: 5,
    scoreCost: 2500,
    description: '以散布的迫擊砲子彈藥覆蓋標記區域。',
    kind: 'call_in',
    duration: 6,
    vehicle: KillstreakVehicleKind.ClusterStrike,
    damage: 150,
    radius: 8,
    unlockLevel: 8,
    friendlyAnnounce: '集束打擊，砲彈已發射。',
    enemyAnnounce: '迫擊砲來襲！離開空曠處！',
  },
  precision_airstrike: {
    id: 'precision_airstrike',
    name: '精準空襲',
    cost: 5,
    scoreCost: 2500,
    description: '兩架戰機沿著你在地圖上畫出的路線投彈。',
    kind: 'call_in',
    duration: 8,
    vehicle: KillstreakVehicleKind.Airstrike,
    damage: 200,
    radius: 12,
    unlockLevel: 10,
    friendlyAnnounce: '空襲接近中，危險距離。',
    enemyAnnounce: '敵方空襲接近中！找掩護！',
  },
  sentry_gun: {
    id: 'sentry_gun',
    name: '哨戒機槍',
    cost: 6,
    scoreCost: 3000,
    description: '自動砲塔，會一直封鎖一個角度，直到被摧毀為止。',
    kind: 'deployable',
    duration: 90,
    damage: 25,
    radius: 30,
    health: 250,
    unlockLevel: 12,
    friendlyAnnounce: '哨戒機槍已部署——那條路線封住了。',
    enemyAnnounce: '敵方哨戒機槍啟動中。從側翼繞過去。',
  },
  cruise_missile: {
    id: 'cruise_missile',
    name: '巡弋飛彈',
    cost: 7,
    scoreCost: 3500,
    description: '從發射到命中，全程遙控飛彈。',
    kind: 'controlled',
    duration: 25,
    vehicle: KillstreakVehicleKind.PredatorMissile,
    damage: 300,
    radius: 9,
    health: 100,
    unlockLevel: 14,
    friendlyAnnounce: '飛彈已發射——控制權在你手上。',
    enemyAnnounce: '敵方飛彈升空！脫離接觸！',
  },
  attack_chopper: {
    id: 'attack_chopper',
    name: '攻擊直升機',
    cost: 7,
    scoreCost: 3500,
    description: 'AI武裝直升機，會自行在地圖上巡邏並交戰。',
    kind: 'call_in',
    duration: 45,
    vehicle: KillstreakVehicleKind.Chopper,
    damage: 45,
    radius: 3,
    health: 900,
    unlockLevel: 16,
    friendlyAnnounce: '攻擊直升機已就位。',
    enemyAnnounce: '敵方直升機接近中——進到室內！',
  },
  vtol_jet: {
    id: 'vtol_jet',
    name: 'VTOL戰機',
    cost: 8,
    scoreCost: 4000,
    description: '對標記目標進行掃射，接著懸停警戒。',
    kind: 'call_in',
    duration: 40,
    vehicle: KillstreakVehicleKind.VTOL,
    damage: 60,
    radius: 5,
    health: 1100,
    unlockLevel: 18,
    friendlyAnnounce: 'VTOL已就位，攻擊你的標記。',
    enemyAnnounce: '敵方VTOL在上空！找堅固掩體！',
  },
  advanced_uav: {
    id: 'advanced_uav',
    name: '進階無人機',
    cost: 8,
    scoreCost: 4000,
    description: '持續掃描的雷達，顯示敵人位置與面向。',
    kind: 'call_in',
    duration: 40,
    vehicle: KillstreakVehicleKind.UAV,
    health: 400,
    unlockLevel: 20,
    friendlyAnnounce: '進階無人機升空——你能看見他們的視線方向。',
    enemyAnnounce: '進階無人機在上空。他們看得一清二楚。',
  },
  chopper_gunner: {
    id: 'chopper_gunner',
    name: '直升機機槍手',
    cost: 9,
    scoreCost: 4500,
    description: '接手盤旋直升機上的機槍座。',
    kind: 'controlled',
    duration: 40,
    vehicle: KillstreakVehicleKind.Chopper,
    damage: 70,
    radius: 3,
    health: 1200,
    unlockLevel: 22,
    friendlyAnnounce: '直升機機槍手——這挺槍歸你了。',
    enemyAnnounce: '敵方直升機機槍手！待在掩體下！',
  },
  gunship: {
    id: 'gunship',
    name: '空中砲艇',
    cost: 10,
    scoreCost: 5000,
    description: '三種武器的定翼平台，緩慢盤旋。戶外沒有安全的地方。',
    kind: 'controlled',
    duration: 40,
    vehicle: KillstreakVehicleKind.AC130,
    damage: 120,
    radius: 6,
    health: 1400,
    unlockLevel: 24,
    friendlyAnnounce: '空中砲艇已就位——准許開火。',
    enemyAnnounce: '敵方空中砲艇在上空！立刻進到室內！',
  },
  emp_burst: {
    id: 'emp_burst',
    name: 'EMP脈衝',
    cost: 11,
    scoreCost: 5500,
    description: '使敵方HUD全黑，並摧毀其空中支援。',
    kind: 'call_in',
    duration: 25,
    damage: 400,
    radius: 200,
    unlockLevel: 26,
    friendlyAnnounce: 'EMP已引爆——他們的裝備全死了。',
    enemyAnnounce: 'EMP！電子設備失效！',
  },
  juggernaut: {
    id: 'juggernaut',
    name: '重裝兵',
    cost: 12,
    scoreCost: 6000,
    description: '空投一箱重型裝甲與彈鏈供彈機槍。行動緩慢，但極難擊殺。',
    kind: 'care_package',
    duration: 0,
    health: 1200,
    unlockLevel: 28,
    friendlyAnnounce: '重裝兵裝甲投放中——去拿。',
    enemyAnnounce: '敵方重裝兵已上場。集中火力！',
  },
  tactical_nuke: {
    id: 'tactical_nuke',
    name: '戰術核彈',
    cost: 25,
    scoreCost: 12500,
    description: '結束這場比賽。所有人陣亡，你的隊伍獲勝。',
    kind: 'call_in',
    duration: 10,
    damage: 100000,
    radius: 10000,
    unlockLevel: 30,
    friendlyAnnounce: '核彈已啟動。十秒。',
    enemyAnnounce: '敵方有核彈！十秒！',
  },
};

export function getKillstreak(id: string): KillstreakDef {
  const def = KILLSTREAKS[id];
  if (!def) throw new Error(`Unknown killstreak: ${id}`);
  return def;
}

/** The classic 3/5/9 loadout every new player starts on. */
export const DEFAULT_KILLSTREAKS: string[] = ['uav', 'precision_airstrike', 'chopper_gunner'];

/** Everything a player at the given streak count has already earned, cheapest first. */
export function killstreaksUpTo(cost: number): KillstreakDef[] {
  return Object.values(KILLSTREAKS)
    .filter((k) => k.cost <= cost)
    .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
}
