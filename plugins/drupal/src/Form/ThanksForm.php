<?php

declare(strict_types=1);

namespace Drupal\runlight\Form;

use Drupal\Core\Form\FormBase;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Url;
use Drupal\user\UserDataInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * The thank you above the dashboard, with a button that closes it for good.
 *
 * Whether someone closed it is kept with their account, in user data, which
 * Drupal removes when the module is uninstalled. Once closed, it shows to
 * them nowhere again, the settings page included. drupal.org has no reviews,
 * so it asks only for a star.
 */
final class ThanksForm extends FormBase {

  /**
   * Accounts' own data, where the closing is kept.
   */
  protected UserDataInterface $userData;

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): static {
    $form = new static();
    $form->userData = $container->get('user.data');
    return $form;
  }

  /**
   * Whether the account has closed the thank you.
   */
  public static function closed(UserDataInterface $data, AccountInterface $account): bool {
    return (bool) $data->get('runlight', (int) $account->id(), 'thanked');
  }

  /**
   * The thank you's words and buttons, the same on the settings page.
   *
   * @return array<string, mixed>
   *   A render array.
   */
  public static function words(): array {
    return [
      'text' => [
        '#markup' => '<p>' . t('Runlight is free and open source. If it is useful to you, a star on GitHub helps other people find it.') . '</p>',
      ],
      'star' => [
        '#type' => 'link',
        '#title' => t('Star it on GitHub'),
        '#url' => Url::fromUri('https://github.com/runlightsh/runlight'),
        '#attributes' => ['class' => ['button'], 'target' => '_blank', 'rel' => 'noopener'],
      ],
    ];
  }

  /**
   * {@inheritdoc}
   */
  public function getFormId(): string {
    return 'runlight_thanks';
  }

  /**
   * {@inheritdoc}
   */
  public function buildForm(array $form, FormStateInterface $form_state): array {
    $form['#attributes'] = [
      'id' => 'runlight-thanks',
      'style' => 'position:relative',
    ];
    $form['#attached']['library'][] = 'runlight/thanks';
    // A fieldset, as on the settings page, which every admin theme draws as a box.
    $form['box'] = [
      '#type' => 'fieldset',
      '#title' => $this->t('Thanks for using Runlight'),
    ] + self::words();
    $form['close'] = [
      '#type' => 'submit',
      '#value' => '×',
      '#attributes' => [
        'aria-label' => $this->t('Dismiss for good'),
        'title' => $this->t('Dismiss for good'),
        'style' => 'position:absolute;top:.25rem;right:.25rem;margin:0;padding:0 .6rem;min-height:0;font-size:1.5rem;line-height:1.6;background:none;border:0;box-shadow:none;color:inherit;cursor:pointer',
      ],
    ];
    return $form;
  }

  /**
   * {@inheritdoc}
   */
  public function submitForm(array &$form, FormStateInterface $form_state): void {
    $this->userData->set('runlight', (int) $this->currentUser()->id(), 'thanked', 1);
  }

}
