import assert from 'assert';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import ora from 'ora';
import { merge } from 'lodash';
import getNpmRegistry from 'getnpmregistry';
import clipboardy from 'clipboardy';
import { winPath } from 'umi-utils';
import { getParsedData, makeSureMaterialsTempPathExist } from './download';
import writeNewRoute from '../../../utils/writeNewRoute';
import { getNameFromPkg } from './getBlockGenerator';
import appendBlockToContainer from './appendBlockToContainer';
import { gitClone, gitUpdate } from './util';
import installDependencies from './installDependencies';

export async function getCtx(url, args = {}, api = {}) {
  const { debug, config } = api;
  debug(`get url ${url}`);

  const ctx = await getParsedData(url, { ...(config.block || {}), ...args });

  if (!ctx.isLocal) {
    const blocksTempPath = makeSureMaterialsTempPathExist(args.dryRun);
    const templateTmpDirPath = join(blocksTempPath, ctx.id);
    merge(ctx, {
      sourcePath: join(templateTmpDirPath, ctx.path),
      branch: args.branch || ctx.branch,
      templateTmpDirPath,
      blocksTempPath,
      repoExists: existsSync(templateTmpDirPath),
    });
  } else {
    merge(ctx, {
      templateTmpDirPath: dirname(url),
    });
  }

  return ctx;
}

async function add(args = {}, opts = {}, api = {}) {
  const { log, paths, debug, config, applyPlugins, uiLog } = api;
  const blockConfig = config.block || {};
  const addLogs = [];
  const getSpinner = uiLog => {
    const spinner = ora();
    return {
      ...spinner,
      succeed: info => spinner.succeed(info),
      start: info => {
        spinner.start(info);
        addLogs.push(info);
        if (uiLog) {
          uiLog('info', info);
        }
      },
      stopAndPersist: (...rest) => spinner.stopAndPersist(rest),
    };
  };

  const spinner = getSpinner(uiLog);
  if (!opts.remoteLog) {
    opts.remoteLog = () => {};
  }

  // 1. parse url and args
  spinner.start('😁  Parse url and args');

  const { url } = args;
  assert(url, `run ${chalk.cyan.underline('umi help block')} to checkout the usage`);

  const useYarn = existsSync(join(paths.cwd, 'yarn.lock'));
  const defaultNpmClient = blockConfig.npmClient || (useYarn ? 'yarn' : 'npm');
  debug(`defaultNpmClient: ${defaultNpmClient}`);
  debug(`args: ${JSON.stringify(args)}`);

  // get faster registry url
  const registryUrl = await getNpmRegistry();

  const {
    path,
    npmClient = defaultNpmClient,
    dryRun,
    skipDependencies,
    skipModifyRoutes,
    page: isPage,
    layout: isLayout,
    registry = registryUrl,
    js,
    uni18n,
  } = args;

  const ctx = await getCtx(url, args, api);
  spinner.succeed();

  // 2. clone git repo
  if (!ctx.isLocal && !ctx.repoExists) {
    opts.remoteLog('Clone the git repo');
    await gitClone(ctx, spinner);
  }

  // 3. update git repo
  if (!ctx.isLocal && ctx.repoExists) {
    try {
      opts.remoteLog('Update the git repo');
      await gitUpdate(ctx, spinner);
    } catch (error) {
      log.info('发生错误，请尝试 `umi block clear`');
    }
  }

  // make sure sourcePath exists
  assert(existsSync(ctx.sourcePath), `${ctx.sourcePath} don't exists`);

  // get block's package.json
  const pkgPath = join(ctx.sourcePath, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`not find package.json in ${this.sourcePath}`);
  } else {
    // eslint-disable-next-line
    ctx.pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  }

  // setup route path
  if (!path) {
    const blockName = getNameFromPkg(ctx.pkg);
    if (!blockName) {
      return log.error("not find name in block's package.json");
    }
    ctx.routePath = `/${blockName}`;
    log.info(`Not find --path, use block name '${ctx.routePath}' as the target path.`);
  } else {
    ctx.routePath = winPath(path);
  }

  // fix demo => /demo
  if (!/^\//.test(ctx.routePath)) {
    ctx.routePath = `/${ctx.routePath}`;
  }

  // 4. install additional dependencies
  // check dependencies conflict and install dependencies
  // install
  opts.remoteLog('Install extra dependencies');
  spinner.start(`📦  install dependencies package`);
  await installDependencies(
    { npmClient, registry, applyPlugins, paths, debug, dryRun, spinner, skipDependencies },
    ctx,
  );
  spinner.succeed();

  // 5. run generator
  opts.remoteLog('Generate files');
  spinner.start(`🔥  Generate files`);
  spinner.stopAndPersist();
  const BlockGenerator = require('./getBlockGenerator').default(api);
  let isPageBlock = ctx.pkg.blockConfig && ctx.pkg.blockConfig.specVersion === '0.1';
  if (isPage !== undefined) {
    // when user use `umi block add --page`
    isPageBlock = isPage;
  }
  debug(`isPageBlock: ${isPageBlock}`);
  const generator = new BlockGenerator(args._ ? args._.slice(2) : [], {
    sourcePath: ctx.sourcePath,
    path: ctx.routePath,
    blockName: getNameFromPkg(ctx.pkg),
    isPageBlock,
    dryRun,
    env: {
      cwd: api.cwd,
    },
    resolved: winPath(__dirname),
  });
  try {
    await generator.run();
  } catch (e) {
    spinner.fail();
    throw new Error(e);
  }

  // write dependencies
  if (ctx.pkg.blockConfig && ctx.pkg.blockConfig.dependencies) {
    const subBlocks = ctx.pkg.blockConfig.dependencies;
    try {
      await Promise.all(
        subBlocks.map(block => {
          const subBlockPath = join(ctx.templateTmpDirPath, block);
          debug(`subBlockPath: ${subBlockPath}`);
          return new BlockGenerator(args._.slice(2), {
            sourcePath: subBlockPath,
            path: isPageBlock ? generator.path : join(generator.path, generator.blockFolderName),
            // eslint-disable-next-line
            blockName: getNameFromPkg(require(join(subBlockPath, 'package.json'))),
            isPageBlock: false,
            dryRun,
            env: {
              cwd: api.cwd,
            },
            resolved: winPath(__dirname),
          }).run();
        }),
      );
    } catch (e) {
      spinner.fail();
      throw new Error(e);
    }
  }
  spinner.succeed();

  // 调用 sylvanas 转化 ts
  if (js) {
    opts.remoteLog('TypeScript to JavaScript');
    spinner.start('🤔  TypeScript to JavaScript');
    require('./tsTojs').default(generator.blockFolderPath);
    spinner.succeed();
  }

  if (uni18n) {
    spinner.start('🌎  remove i18n code');
    require('./remove-locale').default(generator.blockFolderPath, uni18n);
    spinner.succeed();
  }

  // 6. write routes
  if (generator.needCreateNewRoute && api.config.routes && !skipModifyRoutes) {
    opts.remoteLog('Write route');
    spinner.start(`⛱  Write route ${generator.path} to ${api.service.userConfig.file}`);
    // 当前 _modifyBlockNewRouteConfig 只支持配置式路由
    // 未来可以做下自动写入注释配置，支持约定式路由
    const newRouteConfig = applyPlugins('_modifyBlockNewRouteConfig', {
      initialValue: {
        path: generator.path.toLowerCase(),
        component: `.${generator.path}`,
        ...(isLayout ? { routes: [] } : {}),
      },
    });
    try {
      if (!dryRun) {
        writeNewRoute(newRouteConfig, api.service.userConfig.file, paths.absSrcPath);
      }
    } catch (e) {
      spinner.fail();
      throw new Error(e);
    }
    spinner.succeed();
  }

  // 6. import block to container
  if (!generator.isPageBlock) {
    spinner.start(
      `Write block component ${generator.blockFolderName} import to ${generator.entryPath}`,
    );
    try {
      appendBlockToContainer({
        entryPath: generator.entryPath,
        blockFolderName: generator.blockFolderName,
        dryRun,
      });
    } catch (e) {
      spinner.fail();
      throw new Error(e);
    }
    spinner.succeed();
  }

  // Final: show success message
  const viewUrl = `http://localhost:${process.env.PORT || '8000'}${generator.path.toLowerCase()}`;
  try {
    clipboardy.writeSync(viewUrl);
    log.success(
      `probable url ${chalk.cyan(viewUrl)} ${chalk.dim(
        '(copied to clipboard)',
      )} for view the block.`,
    );
  } catch (e) {
    log.success(`probable url ${chalk.cyan(viewUrl)} for view the block.`);
    log.error('copy to clipboard failed');
  }

  return {
    generator,
    ctx,
    logs: addLogs,
  }; // return ctx and generator for test
}

export default add;