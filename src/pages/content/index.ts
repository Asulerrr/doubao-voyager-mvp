import { folderManager } from '../../features/folder/FolderManager';
import { quickLocator } from '../../features/quicklocator/QuickLocator';
import { corpusBoard } from '../../features/corpusboard/CorpusBoard';
import { exportManager } from '../../features/export/ExportManager';
import { latexDownloader } from '../../features/latex/LatexDownloader';
import { storageService } from '../../core/services/StorageService';
import { doubaoAdapter } from '../../platforms/doubao/DoubaoAdapter';

async function main() {
  await doubaoAdapter.waitForWorkspace();
  await storageService.init();
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      folderManager.init();
      quickLocator.init();
      corpusBoard.init();
      exportManager.init();
      latexDownloader.init();
    });
  } else {
    folderManager.init();
    quickLocator.init();
    corpusBoard.init();
    exportManager.init();
    latexDownloader.init();
  }
}

main();
