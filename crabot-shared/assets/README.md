# 音频服务连接测试样本

`voice-service-test.wav` 是固定公开文本“你好，我是螃蟹。”的合成语音，不含用户录音或声纹。来源为 2026-10-10 已记录的 MLX-Audio 0.5.8 / Kokoro v1.0 中文接口实验 `cold-short.wav`，使用 `zf_xiaobei`、`lang_code=z`，通过 FFmpeg 转为 16kHz/mono/PCM16。

样本仅验证 ASR 接口能接收文件并返回文字，不能用于声纹准确率、多人归属或客厅验收。TTS 连接测试使用相同公开文本，不开启终端麦克风。Kokoro 模型许可为 Apache-2.0；模型权重不随本样本分发。
