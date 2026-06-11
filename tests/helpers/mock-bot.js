import { vi } from 'vitest';

export function createMockBot(options = {}) {
  const {
    position = { x: 0, y: 64, z: 0 },
    health = 20,
    food = 20,
    inventory = [],
    protectedZones = [],
    spawnPoint = { x: 0, z: 0 },
  } = options;

  return {
    output: '',
    health,
    food,
    entity: {
      position: { x: position.x, y: position.y, z: position.z },
      yaw: 0,
    },
    game: {
      gameMode: 'survival',
      serverBrand: 'vanilla',
    },
    time: { timeOfDay: 6000 },
    weather: { isRaining: false },
    protectedZones,
    spawnPoint: { x: spawnPoint.x, y: 64, z: spawnPoint.z },
    inventory: {
      items: vi.fn().mockReturnValue(inventory),
      slots: new Array(46).fill(null),
      emptySlotCount: vi.fn().mockReturnValue(36 - inventory.length),
      findInventoryItem: vi.fn().mockReturnValue(null),
    },
    heldItem: inventory[0] || null,
    pathfinder: {
      goto: vi.fn().mockResolvedValue(undefined),
      setMovements: vi.fn(),
      bestHarvestTool: vi.fn().mockReturnValue(null),
      isMoving: vi.fn().mockReturnValue(false),
    },
    collectBlock: {
      collect: vi.fn().mockResolvedValue(undefined),
      movements: null,
    },
    pvp: { attack: vi.fn(), stop: vi.fn() },
    entities: {},
    blockAt: vi.fn().mockReturnValue(null),
    findBlock: vi.fn().mockReturnValue(null),
    findBlocks: vi.fn().mockReturnValue([]),
    nearestEntity: vi.fn().mockReturnValue(null),
    equip: vi.fn().mockResolvedValue(undefined),
    unequip: vi.fn().mockResolvedValue(undefined),
    dig: vi.fn().mockResolvedValue(undefined),
    placeBlock: vi.fn().mockResolvedValue(undefined),
    chat: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    emit: vi.fn(),
    setControlState: vi.fn(),
    clearControlStates: vi.fn(),
    openContainer: vi.fn().mockResolvedValue({
      deposit: vi.fn().mockResolvedValue(undefined),
      withdraw: vi.fn().mockResolvedValue(undefined),
      containerItems: vi.fn().mockReturnValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    activateBlock: vi.fn().mockResolvedValue(undefined),
    openVillager: vi.fn().mockResolvedValue({ trades: [], close: vi.fn() }),
    lookAt: vi.fn().mockResolvedValue(undefined),
    waitForChunksToLoad: vi.fn().mockResolvedValue(undefined),
    world: { getBlock: vi.fn().mockReturnValue(null) },
  };
}
