# 媒体测试样本

以下样本由 FFmpeg 7.1.1 合成，不包含外部内容：

```sh
ffmpeg -f lavfi -i color=c=red:s=64x32 -frames:v 1 image.jpg
exiftool -overwrite_original -Orientation#=6 image.jpg
mv image.jpg rotated.jpg
ffmpeg -f lavfi -i color=c=red:s=64x32 -frames:v 1 -pix_fmt rgba rgba.png
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=8000 -t 0.25 -c:a pcm_s16le audio.wav
ffmpeg -f lavfi -i color=c=red:s=64x32:r=10 -f lavfi -i sine=frequency=440:sample_rate=8000 -t 0.5 -c:v mpeg4 -c:a aac video.mp4
ffmpeg -display_rotation 90 -i video.mp4 -c copy rotated.mp4
```

测试直接读取已提交的文件；运行应用或测试均不需要安装 FFmpeg 和 ExifTool。

AVIF 样本使用 libavif 1.3.0（`avifenc`）生成。两个 `*-exif.avif` 文件保留 JPEG 的 EXIF 方向值 6，并分别设置独立的容器旋转，用于验证 AVIF 显示尺寸仅由容器控制：

```sh
avifenc --jobs 1 --speed 10 --irot 1 rgba.png rotated.avif
avifenc --jobs 1 --speed 10 --irot 1 rotated.jpg rotated-exif.avif
avifenc --jobs 1 --speed 10 --irot 0 rotated.jpg unrotated-exif.avif
avifenc --jobs 1 --speed 10 --crop 0,0,48,16 rgba.png cropped.avif
avifenc --jobs 1 --speed 10 --crop 0,0,48,16 --irot 1 rgba.png cropped-rotated.avif
```

裁剪样本保留 64×32 的编码图像，可显示区域为 48×16；旋转后的版本显示为 16×48。无效裁剪测试会将样本的可显示区域宽度改为 100，验证程序能明确报告无效尺寸。

仅重新生成这些样本时需要 `avifenc`。
