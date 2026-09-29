import { pasteboard } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';

/**
 * 图片导入（UI 层平台辅助；S3-1 编辑页"图片粘贴/选择"入口）。
 *
 * 职责只做"平台字节 → 统一 ImportedImage"：URI 直读原始文件字节（不改质），
 * 剪贴板 PixelMap 走 PNG 打包。内容寻址、原子写入、引用提交全部在 NoteService
 * （领域层，本机用例覆盖）——这里不碰任何业务规则。
 *
 * 读取均由用户显式手势触发（按钮点击），符合设计 §4.1"不预设后台读取权"口径。
 *
 * 编译口径声明（同 G1 探针设施纪律）：主机无 HarmonyOS SDK，本文件未设备编译验证；
 * 以下 API 按 API 12（compatibleSdkVersion 5.0.0(12)）文档口径编写——
 *  - PasteData.hasType / getPrimaryUri / getPrimaryPixelMap（OpenHarmony pasteboard 文档：
 *    API 9+；注意 G1ProbeScenes.ets 使用的是 hasMimeType 旧名，探针块验收时一并回归）；
 *  - ImagePacker.packing（API 8 起、API 13 才废弃；因此用 packing 而非 13+ 的 packToData）；
 *  - photoAccessHelper.PhotoViewPicker（API 11+，隐私模式，无需 READ_IMAGEVIDEO）。
 * 真机编译若遇签名差异，以 SDK 报错为准修正调用形态，不得改变"手势触发 + 原文节直读"语义。
 *
 * 权限边界如实声明：API 12 起 getData() 未授权会抛 201（G1 探测报告 §1）。
 * 剪贴板图片通道存在"系统弹窗/拒绝"两种正常结果，UI 必须展示真实错误而不是吞掉。
 */

export interface ImportedImage {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

function mimeOfUri(uri: string): string {
  const lower: string = uri.toLowerCase();
  if (lower.indexOf('.png') >= 0) {
    return 'image/png';
  }
  if (lower.indexOf('.jpg') >= 0 || lower.indexOf('.jpeg') >= 0) {
    return 'image/jpeg';
  }
  if (lower.indexOf('.gif') >= 0) {
    return 'image/gif';
  }
  if (lower.indexOf('.webp') >= 0) {
    return 'image/webp';
  }
  if (lower.indexOf('.bmp') >= 0) {
    return 'image/bmp';
  }
  return 'application/octet-stream';
}

/** 从 URI 读原始字节（分享/选择器授权的临时可读 URI；"拿到即复制入沙箱"的读取端，G1 §2-③） */
export async function readImageFromUri(uri: string): Promise<ImportedImage> {
  const file: fs.File = await fs.open(uri, fs.OpenMode.READ_ONLY);
  try {
    const stat: fs.Stat = await fs.stat(file.fd);
    if (stat.size <= 0) {
      throw new Error('empty image file');
    }
    const buffer: ArrayBuffer = new ArrayBuffer(stat.size);
    const readLen: number = await fs.read(file.fd, buffer);
    if (readLen <= 0) {
      throw new Error('empty image file');
    }
    return { bytes: new Uint8Array(buffer, 0, readLen), mime: mimeOfUri(uri) };
  } finally {
    await fs.close(file);
  }
}

/**
 * 剪贴板取图：优先 URI（保留原始文件字节），否则 PixelMap 打包 PNG。
 * 无可导入内容时抛错（错误信息即 UI 提示文案——"失败必须如实，不静默吞掉"）。
 */
export async function readImageFromPasteboard(): Promise<ImportedImage> {
  const board: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
  const data: pasteboard.PasteData = await board.getData();
  if (data.hasType(pasteboard.MIMETYPE_TEXT_URI)) {
    const uri: string | undefined = data.getPrimaryUri() as string | undefined;
    if (uri !== undefined && uri !== null && uri.length > 0) {
      return await readImageFromUri(uri);
    }
  }
  if (data.hasType(pasteboard.MIMETYPE_PIXELMAP)) {
    const pixelMap: image.PixelMap | undefined = data.getPrimaryPixelMap() as image.PixelMap | undefined;
    if (pixelMap !== undefined && pixelMap !== null) {
      const packer: image.ImagePacker = image.createImagePacker();
      try {
        const opt: image.PackingOption = { format: 'image/png', quality: 100 };
        const buffer: ArrayBuffer = await packer.packing(pixelMap, opt);
        return { bytes: new Uint8Array(buffer), mime: 'image/png' };
      } finally {
        // 编码实例用完立即释放（图片内存占用大，官方明确要求）；像素本体由系统管理
        await packer.release();
      }
    }
  }
  throw new Error('剪贴板中没有可保存的图片（支持图片文件或截图）。');
}

/** 系统图片选择器（单选；用户取消返回 undefined，不算失败） */
export async function pickImageFromGallery(): Promise<ImportedImage | undefined> {
  const picker: photoAccessHelper.PhotoViewPicker = new photoAccessHelper.PhotoViewPicker();
  const options: photoAccessHelper.PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
  options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
  options.maxSelectNumber = 1;
  const result: photoAccessHelper.PhotoSelectResult = await picker.select(options);
  if (result.photoUris.length === 0) {
    return undefined;
  }
  return await readImageFromUri(result.photoUris[0]);
}
