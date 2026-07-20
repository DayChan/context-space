import type { AnalysisProvider } from "../contracts";

export class AnalysisProviderRegistry {
  private readonly providers = new Map<string, AnalysisProvider>();

  constructor(providers: AnalysisProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: AnalysisProvider): void {
    if (!provider.id.trim()) throw new Error("分析 Provider ID 不能为空");
    if (this.providers.has(provider.id)) {
      throw new Error(`分析 Provider 已注册：${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): AnalysisProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`未注册的分析 Provider：${id}`);
    return provider;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  all(): AnalysisProvider[] {
    return [...this.providers.values()];
  }
}
