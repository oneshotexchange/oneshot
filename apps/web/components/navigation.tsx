import { Link as RouterLink, type LinkProps } from 'react-router-dom';

/** Keep the UI's href-based links while the static web uses browser routing. */
export default function Link({ href, ...props }: Omit<LinkProps, 'to'> & { href: string }) {
  return <RouterLink to={href} {...props} />;
}
