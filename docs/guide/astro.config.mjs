// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightImageZoom from 'starlight-image-zoom';
import starlightSidebarTopics from 'starlight-sidebar-topics';

// The guide is served under /docs of the same domain as the landing page.
export default defineConfig({
  site: 'https://portway.nmtung.dev',
  base: '/docs',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Portway',
      description: 'Portway user guide: connect to Linux servers over SSH, manage files, tunnels and services.',
      favicon: '/favicon.svg',
      logo: { src: './public/mark.svg', alt: 'Portway' },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/AdonisGM/Portway' }],
      editLink: { baseUrl: 'https://github.com/AdonisGM/Portway/edit/main/docs/guide/' },
      // English is the default language: /docs/ is English and /docs/vi/ is Vietnamese.
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        vi: { label: 'Tiếng Việt', lang: 'vi' },
      },
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
        ThemeProvider: './src/components/ThemeProvider.astro',
      },
      customCss: [
        '@fontsource-variable/inter',
        '@fontsource/roboto-mono/400.css',
        '@fontsource/roboto-mono/500.css',
        './src/styles/custom.css',
      ],
      plugins: [
        starlightImageZoom(),
        starlightSidebarTopics([
          {
            label: { en: 'Guide', vi: 'Hướng dẫn' },
            link: '/introduction/what-is-portway/',
            icon: 'open-book',
            items: [
              {
                label: 'Introduction',
                translations: { vi: 'Giới thiệu' },
                items: [{ slug: 'introduction/what-is-portway' }, { slug: 'introduction/why-portway' }],
              },
              {
                label: 'Getting started',
                translations: { vi: 'Bắt đầu' },
                items: [{ slug: 'getting-started/install' }, { slug: 'getting-started/add-server' }, { slug: 'getting-started/interface-tour' }],
              },
              {
                label: 'Servers and access',
                translations: { vi: 'Server và truy cập' },
                items: [
                  { slug: 'servers/manage-servers' },
                  { slug: 'servers/jump-hosts' },
                  { slug: 'servers/ssh-keys' },
                  { slug: 'servers/overview' },
                  { slug: 'servers/sudo' },
                  { slug: 'servers/audit-log' },
                ],
              },
              {
                label: 'Files',
                translations: { vi: 'Tệp' },
                items: [
                  { slug: 'files/browse' },
                  { slug: 'files/permissions-and-root' },
                  { slug: 'files/edit-locally' },
                  { slug: 'files/follow-logs' },
                  { slug: 'files/transfer' },
                ],
              },
              { label: 'Tunnels', translations: { vi: 'Tunnel' }, items: [{ slug: 'tunnels/create' }, { slug: 'tunnels/monitor' }] },
              {
                label: 'Docker',
                items: [{ slug: 'docker/containers' }, { slug: 'docker/compose' }, { slug: 'docker/images-and-volumes' }],
              },
              {
                label: 'Services, web and firewall',
                translations: { vi: 'Dịch vụ, web và firewall' },
                items: [{ slug: 'services/systemd' }, { slug: 'web/nginx' }, { slug: 'web/firewall' }, { slug: 'web/http' }],
              },
              {
                label: 'Connect',
                items: [{ slug: 'connect/overview' }, { slug: 'connect/pairing' }, { slug: 'connect/features' }, { slug: 'connect/troubleshooting' }],
              },
              {
                label: 'Application',
                translations: { vi: 'Ứng dụng' },
                items: [{ slug: 'app/settings' }, { slug: 'app/troubleshooting' }],
              },
            ],
          },
          {
            label: { en: 'Architecture and ideas', vi: 'Kiến trúc và ý tưởng' },
            link: '/architecture/concepts/',
            icon: 'puzzle',
            items: [
              {
                label: 'Ideas',
                translations: { vi: 'Ý tưởng' },
                items: [{ slug: 'architecture/concepts' }],
              },
              {
                label: 'Internals',
                translations: { vi: 'Kỹ thuật bên trong' },
                items: [
                  { slug: 'internals/architecture' },
                  { slug: 'internals/ssh-sessions' },
                  { slug: 'internals/connect-protocol' },
                  { slug: 'internals/security-and-data' },
                ],
              },
            ],
          },
        ]),
      ],
    }),
  ],
});
