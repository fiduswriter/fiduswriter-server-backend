from django.contrib import admin
from django.utils.html import format_html

from usermedia.models import (
    Image,
    UserImage,
    ImageCategory,
    DocumentImage,
    EncryptedDocumentImage,
)


def image_thumbnail(image):
    """Render a small preview of the underlying image file, if available."""
    field = image.thumbnail if hasattr(image, "thumbnail") else None
    if field and field.name:
        try:
            url = field.url
        except ValueError:
            url = None
    else:
        url = None
    if not url and getattr(image, "image", None):
        try:
            url = image.image.url
        except ValueError:
            url = None
    if url:
        return format_html('<img src="{}" style="max-height:40px;max-width:60px;" />', url)
    return "-"


image_thumbnail.short_description = "Preview"


class ImageAdmin(admin.ModelAdmin):
    list_display = ("pk", "image_preview", "file_type", "uploader", "added")
    list_filter = ("file_type", "added")
    search_fields = ("uploader__username",)

    @admin.display(description="Preview")
    def image_preview(self, obj):
        return image_thumbnail(obj)


admin.site.register(Image, ImageAdmin)


class UserImageAdmin(admin.ModelAdmin):
    list_display = (
        "title",
        "image_preview",
        "owner",
    )
    list_filter = ("owner",)
    search_fields = ("title", "owner__username", "owner__email")

    @admin.display(description="Preview")
    def image_preview(self, obj):
        return image_thumbnail(obj.image)


admin.site.register(UserImage, UserImageAdmin)


class DocumentImageAdmin(admin.ModelAdmin):
    list_display = (
        "title",
        "image_preview",
        "document",
        "document_owner",
    )
    search_fields = (
        "title",
        "document__title",
        "document__owner__username",
    )

    @admin.display(description="Preview")
    def image_preview(self, obj):
        return image_thumbnail(obj.image)

    @admin.display(description="Document owner")
    def document_owner(self, obj):
        return obj.document.owner


admin.site.register(DocumentImage, DocumentImageAdmin)


class EncryptedDocumentImageAdmin(admin.ModelAdmin):
    list_display = ("title", "document", "added")
    search_fields = ("title", "document__title")

    @admin.display(description="Document owner")
    def document_owner(self, obj):
        return obj.document.owner


admin.site.register(EncryptedDocumentImage, EncryptedDocumentImageAdmin)


class ImageCategoryAdmin(admin.ModelAdmin):
    list_display = ("category_title", "category_owner")
    search_fields = ("category_title", "category_owner__username")


admin.site.register(ImageCategory, ImageCategoryAdmin)
