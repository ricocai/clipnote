import { common } from '@kit.AbilityKit';

/**
 * 应用上下文持有者。
 *
 * 为什么要有这个类：领域内核（core/）不能依赖 @kit.AbilityKit，而沙箱根路径只能从
 * UIAbility 的 context 取得。这里把"取路径"这一平台事实收敛到最薄的一层，
 * 内核只接收一个字符串根路径（见 BlobCas 的构造参数）。
 */
export class AppContextHolder {
  private static context: common.UIAbilityContext | undefined = undefined;

  static set(context: common.UIAbilityContext): void {
    AppContextHolder.context = context;
  }

  /** 应用私有沙箱根（卸载即清理，符合"数据默认不出设备"）。 */
  static filesDir(): string {
    const ctx: common.UIAbilityContext | undefined = AppContextHolder.context;
    if (ctx === undefined) {
      throw new Error('AppContextHolder: context not set; call set() in EntryAbility.onCreate');
    }
    return ctx.filesDir;
  }

  static cacheDir(): string {
    const ctx: common.UIAbilityContext | undefined = AppContextHolder.context;
    if (ctx === undefined) {
      throw new Error('AppContextHolder: context not set; call set() in EntryAbility.onCreate');
    }
    return ctx.cacheDir;
  }
}
