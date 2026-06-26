import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoUploadIncompleteException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_INCOMPLETE',
      422,
      'Video file not yet uploaded to storage',
    );
  }
}
