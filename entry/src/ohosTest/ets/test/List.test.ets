import dataLayerTest from './DataLayer.test';
import speechEngineTest from './SpeechEngine.test';

export default function testsuite(): void {
  dataLayerTest();
  speechEngineTest();
}
