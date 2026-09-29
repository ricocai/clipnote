import dataLayerTest from './DataLayer.test';
import speechEngineTest from './SpeechEngine.test';
import keyChainTest from './KeyChain.test';

export default function testsuite(): void {
  dataLayerTest();
  speechEngineTest();
  keyChainTest();
}
