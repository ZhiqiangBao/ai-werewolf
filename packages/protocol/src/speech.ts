/** 客户端只获得提供方名称，不获得地址、密钥、模型参数或适配器路径。 */
export interface SpeechProviderView { id: string; label: string }
export interface SpeechProvidersView {
  providers: SpeechProviderView[];
  defaultProviderId: string | null;
  error?: string;
}
