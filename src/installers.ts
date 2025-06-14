/* eslint-disable */
import { fs, selectors, types } from 'vortex-api';
import path from 'path';

import { MODS_FILE_BACKUP, GAME_ID, UE4SS_SETTINGS_FILE,
  BINARIES_PATH, MODS_FILE, LUA_EXTENSIONS,
  UE4SSRequirement,
  UE4SS_DWMAPI
} from './common';

import { getTopLevelPatterns } from './stopPatterns';

//#region UE4SS Installer and test.
export async function testUE4SSInjector(files: string[], gameId: string): Promise<types.ISupportedResult> {
  const supported = gameId === GAME_ID && files.some(file => path.basename(file).toLowerCase() === UE4SS_SETTINGS_FILE.toLowerCase());
  return { supported, requiredFiles: [] };
}

export const installUE4SSInjector = (api: types.IExtensionApi) => async (files: string[], destinationPath: string, gameId: string): Promise<types.IInstallResult> => {
  const state = api.getState();
  const discovery = selectors.discoveryByGame(state, gameId);
  const gameStore = discovery.store ?? 'steam';
  // Different gamestores means different target path?
  const architecture = gameStore === 'xbox' ? 'WinGDK' : 'Win64';
  const dwmapiFile = files.find(file => path.basename(file).toLowerCase() === UE4SS_DWMAPI);
  const dwmapiSegments = dwmapiFile?.split(path.sep) ?? [];
  const cutoffIdx = dwmapiSegments.indexOf(UE4SS_DWMAPI);
  const targetPath = path.join(BINARIES_PATH, architecture);
  const instructions = await files.reduce(async (accumP, iter) => {
    const accum = await accumP;
    const segments = iter.split(path.sep);
    if (segments.length >= cutoffIdx && path.extname(segments[segments.length - 1]) !== '') {
      const newPath = segments.slice(cutoffIdx).join(path.sep);
      const destination = path.join(targetPath, newPath);
      const modsFileExists = files.some(file => path.basename(file).toLowerCase() === MODS_FILE.toLowerCase());
      if (!modsFileExists) {
        const defaultData = [
          {
            "mod_name": "BPML_GenericFunctions",
            "mod_enabled": true
          },
          {
            "mod_name": "BPModLoaderMod",
            "mod_enabled": true
          },
        ];

        const modsInstr: types.IInstruction = {
          type: 'generatefile',
          data: JSON.stringify(defaultData, null, 2),
          destination: MODS_FILE_BACKUP,
        }
        accum.push(modsInstr);
      }

      if (path.basename(iter) === MODS_FILE) {
        const modsData: string = await fs.readFileAsync(path.join(destinationPath, iter), { encoding: 'utf8' });
        const modsInstr: types.IInstruction = {
          type: 'generatefile',
          data: modsData,
          destination: MODS_FILE_BACKUP,
        }
        accum.push(modsInstr);
        return accum;
      }

      const instruction: types.IInstruction = {
        type: 'copy',
        source: iter,
        destination,
      }
      accum.push(instruction);
    }
    return accum;
  }, Promise.resolve([]));
  const expectedInstallDir = path.basename(destinationPath, '.installing');
  const version = UE4SSRequirement.fileArchivePattern.exec(expectedInstallDir);
  if (version) {
    const versionAttrib: types.IInstruction = {
      type: 'attribute',
      key: 'version',
      value: version[1],
    }
    instructions.push(versionAttrib);
  }
  instructions.push({
    type: 'setmodtype',
    value: '',
  })
  return { instructions };
}
//#endregion

//#region LUA
export async function testLuaMod(files: string[], gameId: string): Promise<types.ISupportedResult> {
  const rightGame = gameId === GAME_ID;
  const rightFile = files.some(file => LUA_EXTENSIONS.includes(path.extname(file)));
  const supported = rightGame && rightFile;
  return { supported, requiredFiles: [] };
}

export const installLuaMod = (api: types.IExtensionApi) => async (files: string[], destinationPath: string, gameId: string): Promise<types.IInstallResult> => {
  const luaFiles = files.filter(file => LUA_EXTENSIONS.includes(path.extname(file)));
  // We want the lua with the shortest path first as we're going to use that
  //  to ascertain if the mod requires a parent directory added or not.
  luaFiles.sort((a, b) => a.length - b.length);
  const shortest = luaFiles[0];
  const segments = shortest.split(path.sep);

  const modsSegmentIdx = segments.map(seg => !!seg && seg.toLowerCase()).indexOf('mods');
  const folderId = (modsSegmentIdx !== -1)
    ? segments[modsSegmentIdx + 1]
    : (segments.length > 1)
      ? segments[0]
      : path.basename(destinationPath, '.installing');

  const attrInstr: types.IInstruction = {
    type: 'attribute',
    key: 'folderId',
    value: folderId,
  }
  const instructions = files.reduce((accum, iter) => {
    if (iter.endsWith(path.sep) || path.extname(iter) === '') {
      // No directories
      return accum;
    }
    const fileSegments = iter.split(path.sep);
    const destination = (modsSegmentIdx !== -1)
      ? path.join(fileSegments.slice(modsSegmentIdx).join(path.sep))
      : (fileSegments.length > 1)
        ? path.join('Mods', folderId, fileSegments.slice(1).join(path.sep))
        : path.join('Mods', folderId, iter);

    const instruction: types.IInstruction = {
      type: 'copy',
      source: iter,
      destination,
    };
    accum.push(instruction);
    return accum;
  }, [attrInstr]);
  return Promise.resolve({ instructions });
}
//#endregion

//#region root mod
export async function testRootMod(files: string[], gameId: string): Promise<types.ISupportedResult> {
  const rightGame = gameId === GAME_ID;
  const hasModuleConfig = files.some(file => path.basename(file).toLowerCase() === 'moduleconfig.xml');
  const runThroughPatterns = (patterns: string[]) => {
    for (const pattern of patterns) {
      const regex = new RegExp(pattern, 'i');
      for (const file of files) {
        const normal = file.replace(/\\/g, '/');
        if (regex.test(normal)) {
          return true;
        }
      }
    }
    return false;
  };
  const rightStructure = runThroughPatterns(getTopLevelPatterns(true));
  return Promise.resolve({ supported: rightGame && rightStructure && !hasModuleConfig, requiredFiles: [] });
}

export const installRootMod = (api: types.IExtensionApi) => (files: string[], destinationPath: string, gameId: string): Promise<types.IInstallResult> => {
  const setModInstr: types.IInstruction = {
    type: 'setmodtype',
    value: '',
  };
  // I guess that if we're here - that means that we can just copy the files over?
  const instructions = files.reduce((accum, iter) => {
    if (iter.endsWith(path.sep) || path.extname(iter) === '') {
      // No directories
      return accum;
    }
    const instr: types.IInstruction = {
      type: 'copy',
      source: iter,
      destination: iter,
    }
    accum.push(instr);
    return accum;
  }, [setModInstr]);

  return Promise.resolve({ instructions });
}
//#endregion