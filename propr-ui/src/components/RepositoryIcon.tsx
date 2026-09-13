import React, { useMemo, useState } from 'react';
import { Github } from 'lucide-react';
import { buildRepositoryIconUrl } from '../utils/repositoryIconUrl';

interface RepositoryIconProps {
  repository: string;
  iconPath?: string | null;
  revision?: string | null;
  className?: string;
  fallbackClassName?: string;
}

export const RepositoryIcon: React.FC<RepositoryIconProps> = ({
  repository,
  iconPath,
  revision,
  className = 'w-4 h-4',
  fallbackClassName = 'text-gray-400',
}) => {
  const imageUrl = useMemo(
    () => iconPath ? buildRepositoryIconUrl(repository, iconPath, revision || 'HEAD') : null,
    [repository, iconPath, revision],
  );
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (imageUrl && failedUrl !== imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        data-testid="repository-icon-image"
        className={`${className} rounded flex-shrink-0 object-contain`}
        onError={() => setFailedUrl(imageUrl)}
      />
    );
  }

  return (
    <Github
      data-testid="repository-icon-fallback"
      className={`${className} ${fallbackClassName} flex-shrink-0`}
    />
  );
};
